// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import {
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  flushOTel,
  getWeaveTracer,
  init as weaveInit,
} from "weave";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { setBoundedMap } from "./otel/bounded-map.js";
import { mapDiagnosticEventToWeaveSpan } from "./event-mapper.js";
import type { WeaveHookState } from "./hook-state.js";
import { InvokeAgentIndex } from "./otel/invoke-agent-index.js";
import { PendingTraceState } from "./otel/pending-trace-state.js";
import { sanitizeAttrStringWithFlag } from "./otel/redact.js";
import { SpanRegistry, type DebugLogger } from "./otel/span-registry.js";
import {
  resolveContentCapture,
  type RawWeavePluginConfig,
  type ResolvedWeavePluginConfig,
} from "./weave/types.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./weave/version.js";

const DEFAULT_SERVICE_NAME = "openclaw-agent";

/**
 * Parse `OPENCLAW_WEAVE_DEBUG` env into a flag set. Comma-separated values:
 *   - "spans": log every span creation/drop with parent-resolution status
 *   - "trace-tree": after every span start/finalize, dump the full set of
 *     currently-active spans grouped by traceId with indentation reflecting
 *     parent linkage. Use when `spans` log line entries individually look
 *     correct but the resulting tree shape is wrong (e.g. multiple
 *     invoke_agents per agent run).
 * Empty/unset → all flags off. Exported for tests.
 *
 * @internal
 */
export function parseDebugFlags(raw: string | undefined): {
  spans: boolean;
  traceTree: boolean;
} {
  const tokens = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    spans: tokens.includes("spans"),
    traceTree: tokens.includes("trace-tree"),
  };
}

/**
 * Resolve the agent version to set as `weave.agent.version` on every emitted
 * span. Supports:
 *   - explicit string  -> use as-is
 *   - "auto"           -> generate `<pkgVersion>+<startupISO>` so each gateway
 *                         restart produces a distinct version row in the
 *                         Weave Agents tab
 *   - undefined        -> default to the plugin package version
 */
function resolveAgentVersion(raw: string | undefined): string {
  if (!raw) {
    return PACKAGE_VERSION;
  }
  if (raw === "auto") {
    // SemVer 2.0 build-metadata only allows [0-9A-Za-z-], so strip the
    // T separator and trailing Z. Result is sortable + URL-safe.
    // Example: 0.1.0+20260430214213
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .replace(/\.\d{3}Z$/, "");
    return `${PACKAGE_VERSION}+${ts}`;
  }
  return raw;
}
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const MIN_FLUSH_INTERVAL_MS = 1000;

/**
 * Soft caps on internal Maps to prevent unbounded growth if the diagnostic
 * event stream stops mid-flight (gateway crash, dropped conversation, etc.).
 * Maps preserve insertion order, so eviction is FIFO — the oldest entry is
 * dropped first.
 */
const MAX_ACTIVE_SPANS = 4096;
const MAX_TRACE_SESSION_KEYS = 4096;

export type CreateWeaveServiceParams = {
  pluginConfig?: unknown;
  /**
   * Shared hook state populated by `api.on("llm_input"|"llm_output"|...)`
   * subscriptions in the plugin entry. The service reads from it when
   * finalizing chat / execute_tool spans to attach prompt content, assistant
   * output, token usage, tool arguments, and tool results — all of which the
   * diagnostic event stream alone does not carry.
   */
  hookState?: WeaveHookState;
};

/**
 * Returned by createWeaveService — exposes side-channel callbacks the plugin
 * entry uses from inside hooks that don't have a matching diagnostic event.
 *
 * - `emitCompactionSpan` ← `after_compaction` hook (no matching diagnostic
 *   event for context compaction).
 * - `startSubagentSpan` / `endSubagentSpan` ← `subagent_spawned` /
 *   `subagent_ended` hooks (no matching diagnostic events for subagents).
 */
export type WeaveServiceWithCallbacks = {
  service: OpenClawPluginService;
  emitCompactionSpan: (params: CompactionSpanParams) => void;
  startSubagentSpan: (params: SubagentSpanStartParams) => void;
  endSubagentSpan: (params: SubagentSpanEndParams) => void;
  emitAgentEndSummary: (params: AgentEndSummaryParams) => void;
  emitMessageReceived: (params: MessageReceivedParams) => void;
  emitSessionStart: (params: SessionStartParams) => void;
  emitSessionEnd: (params: SessionEndParams) => void;
  /**
   * Finalize a chat span whose `model.call.completed` was deferred. Called
   * from the `llm_output` hook in index.ts after capturing assistantTexts /
   * lastAssistant / usage into hookState. See the comment on
   * `pendingChatCloseByCallId` for the timing reason this exists.
   */
  flushChatSpan: (callId: string) => void;
  /** Snapshot of plugin state, used by the `/weave status` command. */
  getStatus: () => WeaveStatusSnapshot;
};

/**
 * Snapshot returned by `getStatus()` and rendered by `/weave status`.
 *
 * `lifecycle` answers "is export happening?":
 *   - `disabled` — config.enabled=false (operator opt-out)
 *   - `not-started` — service.start() has not been called yet
 *   - `config-error` — start() ran but bailed before exporter init
 *   - `running` — start() completed; exports may be flowing
 *   - `stopped` — stop() was called
 */
export type WeaveStatusSnapshot = {
  pluginVersion: string;
  lifecycle: "disabled" | "not-started" | "config-error" | "running" | "stopped";
  /** Operator-actionable reason set when lifecycle is disabled/config-error. */
  lifecycleDetail?: string;
  /** When start() completed; absent if it never has. */
  startedAt?: number;
  config?: {
    entity: string;
    project: string;
    serviceName: string;
    agentVersion?: string;
    flushIntervalMs: number;
    captureSummary: string;
    stripSenderWrapper: boolean;
    /** Where the W&B API key was resolved from (env / config / vault / etc.). */
    authSource: string;
    /** Weave Agents tab URL for this entity/project (cloud only). */
    uiUrl?: string;
  };
  /** OpenClaw spans currently indexed in the SpanRegistry. */
  activeSpans: number;
};

export type CompactionSpanParams = {
  startTimeMs: number;
  endTimeMs: number;
  itemsBefore: number;
  itemsAfter: number;
  tokenCount?: number;
  agentName?: string;
  conversationId?: string;
  /** Optional parent OpenClaw spanId — links under the active invoke_agent. */
  parentOpenclawSpanId?: string;
};

export type SubagentSpanStartParams = {
  startTimeMs: number;
  /** Requester's runId — used to look up the parent invoke_agent for linkage. */
  requesterRunId: string | undefined;
  /** Subagent's own runId — unique key for tracking the in-flight span. */
  subagentRunId: string;
  agentId: string;
  label?: string;
  childSessionKey: string;
  mode: "run" | "session";
};

export type SubagentSpanEndParams = {
  endTimeMs: number;
  subagentRunId: string;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
};

export type AgentEndSummaryParams = {
  runId: string;
  success: boolean;
  error?: string;
  durationMs?: number;
  /** Final assistant message — only emitted when captureContent is on. */
  lastAssistantMessage?: string;
};

export type MessageReceivedParams = {
  runId?: string;
  /** SessionKey is the fallback target when runId is unset — finds invoke_agent
   * by sessionKey if no runId. */
  sessionKey?: string;
  from: string;
  /** Inbound channel name (e.g. "telegram", "slack"). Optional. */
  channel?: string;
  /** Truncated/masked content; only emitted when captureContent is enabled. */
  content?: string;
};

export type SessionStartParams = {
  sessionKey: string;
  resumedFrom?: string;
};

export type SessionEndParams = {
  sessionKey: string;
  reason?: string;
  durationMs?: number;
  messageCount?: number;
};

/**
 * Long-lived service that subscribes to OpenClaw diagnostic events and emits
 * spans to W&B Weave's `/agents/otel/v1/traces` endpoint.
 *
 * The service delegates OTel transport to the Weave Node SDK
 * (`weave.init()` + `getWeaveTracer()`), which owns provider /
 * processor / exporter / auth / endpoint resolution.
 *
 * In-flight state is split across three owners (instantiated at start(),
 * cleared at stop()):
 *
 *   - `SpanRegistry` — every indexed span keyed by OpenClaw spanId, plus the
 *     parent-resolution + orphan-drop policy for new spans. All emit sites
 *     (mapper-driven, compaction, subagent) route through it.
 *   - `InvokeAgentIndex` — invoke_agent root spans indexed by traceId / runId
 *     / sessionKey, so non-mapper emit sites (session, message_received,
 *     subagent, model.usage, tool.loop) can find the right span by whichever
 *     id their hook payload carries.
 *   - `PendingTraceState` — buffers for side-channel data that may arrive
 *     before its invoke_agent span exists (cost, aggregate usage, tool.loop
 *     events, context snapshots, session_start). Drained at invoke_agent
 *     start; final cost stamped at invoke_agent end.
 *
 * Returns the registrable plugin service plus several side-channel callbacks
 * the plugin entry calls from `api.on(...)` hooks that don't have matching
 * diagnostic events (compaction, subagent, message_received, session, etc.).
 */
export function createWeaveService(
  params: CreateWeaveServiceParams,
): WeaveServiceWithCallbacks {
  let tracer: Tracer | undefined;
  let unsubscribe: (() => void) | undefined;
  let resolvedCfg: ResolvedWeavePluginConfig | undefined;

  let spans: SpanRegistry | undefined;
  let invokeAgents: InvokeAgentIndex | undefined;
  let pending: PendingTraceState | undefined;
  /**
   * Spans for in-flight subagent invocations, keyed by the subagent's OWN
   * runId — distinct from `InvokeAgentIndex.byRunId`, which is keyed by the
   * *requester's* runId. The two namespaces are not interchangeable: a
   * subagent's runId never appears in `InvokeAgentIndex` (subagents emit
   * their model/tool spans in a separate trace), and a requester's runId
   * never appears here.
   *
   * Tracked separately from `SpanRegistry` (rather than indexed by OpenClaw
   * spanId) because the `subagent_spawned` / `subagent_ended` hooks don't
   * carry a spanId — only the subagent's runId.
   */
  const subagentSpansBySubagentRunId = new Map<string, Span>();

  /**
   * Chat-span finalizes whose actual close has been deferred until the
   * `llm_output` hook fires. Keyed by the model call's `callId`.
   *
   * Why: OpenClaw's runtime emits `model.call.completed` (async-queued via
   * setImmediate) BEFORE the agent loop fires `llm_output` (which carries
   * the assistant content). If we closed the chat span at model.call.completed
   * time, hookState would still be empty and `weave.output.messages` / usage
   * / reasoning_content would all be blank. We stash here, then flush from
   * the llm_output hook handler in index.ts (via the `flushChatSpan`
   * callback).
   */
  type PendingChatClose = {
    openclawSpanId: string;
    attrs: Record<string, string | number | boolean>;
    status: "ok" | "error";
    errorType?: string;
    endTimeMs: number;
    traceId: string;
    conversationIdHint: string | undefined;
    event: DiagnosticEventPayload;
  };
  const pendingChatCloseByCallId = new Map<string, PendingChatClose>();

  let stopped = false;
  /** Read at start() time so env changes take effect on plugin reload. */
  let debugTraceTree = false;
  /** Wired into SpanRegistry; logs span-create / orphan-drop / trace-tree. */
  let debugLogger: DebugLogger | undefined;
  /**
   * Set at start() time. handleEvent calls this after every mapper result so
   * `*_truncated: true` attrs surface as rate-limited warnings instead of
   * silently riding the span. Undefined when the service isn't started.
   */
  let noteTruncationsInAttrs:
    | ((attrs: Record<string, string | number | boolean>) => void)
    | undefined;

  /**
   * Lifecycle state for `/weave status`. Distinct from `stopped` because the
   * boolean alone can't tell "haven't started yet" from "stopped" from
   * "started but disabled by config". Updated on every transition.
   */
  let lifecycle: WeaveStatusSnapshot["lifecycle"] = "not-started";
  let lifecycleDetail: string | undefined;
  let startedAt: number | undefined;
  let resolvedAuthSource: string | undefined;
  let resolvedUiUrl: string | undefined;
  let resolvedCaptureSummary: string | undefined;

  const service: OpenClawPluginService = {
    id: "weave",
    async start(ctx) {
      // Defensive re-entrancy guard: if start() is called twice (e.g. plugin
      // reload) without an intervening stop(), tear down the prior state
      // first so we don't leak a subscription.
      if (unsubscribe) {
        await teardownInternal();
      }

      stopped = false;
      lifecycle = "not-started";
      lifecycleDetail = undefined;
      startedAt = undefined;
      resolvedAuthSource = undefined;
      resolvedUiUrl = undefined;
      resolvedCaptureSummary = undefined;
      const flags = parseDebugFlags(process.env.OPENCLAW_WEAVE_DEBUG);
      debugTraceTree = flags.traceTree;
      if (flags.spans || flags.traceTree) {
        const log = ctx.logger;
        debugLogger = {
          debug: (msg: string) => {
            // ctx.logger.debug may be optional on some host SDK shims; fall
            // back to .info when missing so debug output isn't lost.
            (log.debug ?? log.info)(msg);
          },
        };
      } else {
        debugLogger = undefined;
      }

      const raw = (params.pluginConfig ?? {}) as RawWeavePluginConfig;

      if (raw.enabled === false) {
        lifecycle = "disabled";
        lifecycleDetail = "config.enabled=false";
        // `warn` (not `info`) so operators tailing gateway logs notice the
        // plugin is intentionally inert. The plugin is loaded (bytes shipped,
        // schema validated) but won't emit a single span until enabled flips.
        ctx.logger.warn(
          "weave: configured but disabled (config.enabled=false). Set config.enabled=true to start exporting to W&B Weave.",
        );
        return;
      }

      // Dev/onboarding ergonomics: if entity/project are omitted, default to
      // `$USER` and `openclaw-default` so `pnpm install && start gateway` just
      // works. Logged at warn level so operators see exactly what defaulted
      // and how to override for production.
      let entity = nonEmptyString(raw.entity);
      let project = nonEmptyString(raw.project);
      const defaultsApplied: string[] = [];
      if (!entity) {
        const inferred =
          nonEmptyString(process.env.USER) ?? nonEmptyString(process.env.USERNAME);
        if (!inferred) {
          lifecycle = "config-error";
          lifecycleDetail = "config.entity is required";
          ctx.logger.error(
            "weave: config.entity is required and could not be defaulted ($USER/$USERNAME env unset). Set plugins.entries.weave.config.entity in your OpenClaw gateway config to your W&B team or username slug.",
          );
          return;
        }
        entity = inferred;
        defaultsApplied.push(`entity=${entity} (from $USER)`);
      }
      if (!project) {
        project = "openclaw-default";
        defaultsApplied.push(`project=${project}`);
      }
      if (defaultsApplied.length > 0) {
        ctx.logger.warn(
          `weave: applied dev defaults [${defaultsApplied.join(", ")}]. For production set plugins.entries.weave.config.{entity,project} to point to a real W&B project.`,
        );
      }

      const flushInterval = clampFlushInterval(raw.flushIntervalMs);
      const serviceName = raw.serviceName?.trim() || DEFAULT_SERVICE_NAME;
      const projectId = `${entity}/${project}`;

      // Auth: if config supplied an apiKey, resolve it and push it into
      // WANDB_API_KEY env before init(). Otherwise the SDK reads
      // WANDB_API_KEY / .netrc itself.
      let authSource = "WANDB_API_KEY env";
      try {
        const apiKey = await resolveApiKeyMaybe(raw.apiKey);
        if (apiKey) {
          process.env.WANDB_API_KEY = apiKey.value;
          authSource = apiKey.source;
        } else if (!process.env.WANDB_API_KEY) {
          throw new Error(
            "no W&B API key found (set WANDB_API_KEY env, weave.apiKey config, or run `wandb login`)",
          );
        }

        await weaveInit(projectId, {
          genai: { batchOptions: { scheduledDelayMillis: flushInterval } },
        });
      } catch (err) {
        lifecycle = "config-error";
        lifecycleDetail = formatErr(err);
        ctx.logger.error(`weave: configuration error: ${formatErr(err)}`);
        return;
      }
      resolvedAuthSource = authSource;

      tracer = getWeaveTracer(PACKAGE_NAME);
      spans = new SpanRegistry(tracer, MAX_ACTIVE_SPANS, debugLogger);
      invokeAgents = new InvokeAgentIndex(MAX_TRACE_SESSION_KEYS);
      pending = new PendingTraceState(MAX_TRACE_SESSION_KEYS);

      const resolvedAgentVersion = resolveAgentVersion(raw.agentVersion);
      resolvedCfg = {
        entity,
        project,
        serviceName,
        agentName: raw.agentName,
        agentVersion: resolvedAgentVersion,
        agentDescription: raw.agentDescription,
        captureContent: resolveContentCapture(raw.captureContent),
        flushIntervalMs: flushInterval,
        stripSenderWrapper: raw.stripSenderWrapper === true,
      };

      // Per-event-type rate limiter for handler exceptions. Without this,
      // a malformed event class (or a mapper bug) floods ctx.logger.warn on
      // every event of that type. Emit on the first error per type per 60s
      // window, surface the suppressed count when the window flips.
      const handlerErrorBuckets = new Map<
        string,
        { windowStart: number; suppressed: number }
      >();
      const reportHandlerError = (eventType: string, msg: string): void => {
        const t = Date.now();
        const b = handlerErrorBuckets.get(eventType);
        if (!b || t - b.windowStart > 60_000) {
          if (b && b.suppressed > 0) {
            ctx.logger.warn(
              `weave: ${b.suppressed} additional handler errors of type ${eventType} suppressed in last window. New error: ${msg}`,
            );
          } else {
            ctx.logger.warn(msg);
          }
          handlerErrorBuckets.set(eventType, { windowStart: t, suppressed: 0 });
          return;
        }
        b.suppressed += 1;
      };

      // Per-attribute-key rate limiter for `*_truncated: true` sightings.
      // Without this, operators see the boolean on the span but never the
      // operational fact ("10% of your traces are getting clamped, raise the
      // limit"). Mirrors `handlerErrorBuckets`: first hit per attr per 60s
      // window logs at warn; subsequent hits increment a suppressed counter;
      // the next window-flip reports the count alongside the new occurrence.
      const truncationBuckets = new Map<
        string,
        { windowStart: number; suppressed: number }
      >();
      const reportTruncation = (attrKey: string): void => {
        const t = Date.now();
        const b = truncationBuckets.get(attrKey);
        if (!b || t - b.windowStart > 60_000) {
          if (b && b.suppressed > 0) {
            ctx.logger.warn(
              `weave: ${b.suppressed} additional truncations of ${attrKey} suppressed in last window; payload still exceeds 256KiB attribute budget`,
            );
          } else {
            ctx.logger.warn(
              `weave: ${attrKey} exceeded 256KiB attribute budget; payload was structurally truncated`,
            );
          }
          truncationBuckets.set(attrKey, { windowStart: t, suppressed: 0 });
          return;
        }
        b.suppressed += 1;
      };
      noteTruncationsInAttrs = (attrs) => {
        for (const [k, v] of Object.entries(attrs)) {
          if (v === true && k.endsWith("_truncated")) {
            reportTruncation(k.slice(0, -"_truncated".length));
          }
        }
      };

      // We use onInternalDiagnosticEvent (not onDiagnosticEvent) because the
      // public onDiagnosticEvent filters OUT trusted events, but those are
      // exactly the ones we need (model.call.*, harness.run.*, etc.). The
      // listener metadata lets us filter to trusted-only — we never emit
      // spans for adversarial / channel-originated untrusted events.
      unsubscribe = onInternalDiagnosticEvent((event, meta) => {
        if (stopped) return;
        if (!meta.trusted) return;
        try {
          handleEvent(event, meta);
        } catch (err) {
          reportHandlerError(
            event.type,
            `weave: error handling ${event.type}: ${formatErr(err)}`,
          );
        }
      });

      const captureFields: string[] = [];
      if (resolvedCfg.captureContent.inputMessages) captureFields.push("inputMessages");
      if (resolvedCfg.captureContent.outputMessages) captureFields.push("outputMessages");
      if (resolvedCfg.captureContent.toolArguments) captureFields.push("toolArguments");
      if (resolvedCfg.captureContent.toolResults) captureFields.push("toolResults");
      if (resolvedCfg.captureContent.systemInstructions) captureFields.push("systemInstructions");
      const captureSummary =
        captureFields.length === 0
          ? "off"
          : captureFields.length === 5
            ? "full"
            : captureFields.join(",");
      resolvedCaptureSummary = captureSummary;
      // Cloud Weave UI lives at wandb.ai regardless of which W&B base API URL
      // is hit. Treat unset OR the cloud default as cloud; anything else is
      // a dedicated install with its own UI host that we don't try to guess.
      const wandbBase = process.env.WANDB_BASE_URL?.trim();
      resolvedUiUrl =
        !wandbBase || wandbBase === "https://api.wandb.ai"
          ? `https://wandb.ai/${projectId}/weave`
          : undefined;
      lifecycle = "running";
      startedAt = Date.now();
      if (resolvedUiUrl) ctx.logger.info(`weave: dashboard ${resolvedUiUrl}`);
      ctx.logger.info(
        `weave: project=${projectId} service=${serviceName} agentVersion=${resolvedAgentVersion} ` +
          `auth=${authSource} flushIntervalMs=${flushInterval} ` +
          `stripSenderWrapper=${resolvedCfg.stripSenderWrapper} ` +
          `captureContent=${captureSummary}`,
      );
    },

    async stop(ctx) {
      stopped = true;
      lifecycle = "stopped";
      try {
        await teardownInternal();
      } catch (err) {
        ctx?.logger?.warn?.(`weave: shutdown error: ${formatErr(err)}`);
      }
    },
  };

  function emitCompactionSpan(p: CompactionSpanParams): void {
    if (!spans || !resolvedCfg || stopped) return;
    const attrs: Record<string, string | number | boolean> = {
      "weave.operation.name": "context_compacted",
      "gen_ai.agent.name": p.agentName ?? resolvedCfg.agentName ?? "openclaw",
      "weave.compaction.items_before": Math.max(0, Math.trunc(p.itemsBefore)),
      "weave.compaction.items_after": Math.max(0, Math.trunc(p.itemsAfter)),
    };
    if (resolvedCfg.agentVersion) attrs["weave.agent.version"] = resolvedCfg.agentVersion;
    if (p.conversationId) attrs["gen_ai.conversation.id"] = p.conversationId;
    if (typeof p.tokenCount === "number") {
      attrs["weave.compaction.summary"] = `${p.itemsBefore} -> ${p.itemsAfter} (${p.tokenCount} tokens)`;
    } else {
      attrs["weave.compaction.summary"] = `${p.itemsBefore} -> ${p.itemsAfter}`;
    }

    const opened = spans.openSpan({
      spanName: "context_compacted",
      spanKind: SpanKind.INTERNAL,
      openclawParentSpanId: p.parentOpenclawSpanId,
      parentSpan: p.parentOpenclawSpanId
        ? spans.get(p.parentOpenclawSpanId)
        : undefined,
      claimsParent: !!p.parentOpenclawSpanId,
      allowRootless: false,
      attrs,
      startTimeMs: p.startTimeMs,
      debugContext: `parentOpenclawSpanId=${p.parentOpenclawSpanId ?? "<none>"}`,
    });
    if (opened.kind !== "ok") return;
    opened.span.end(new Date(p.endTimeMs));
  }

  /**
   * Start a `invoke_agent <agentId>` span representing a subagent invocation.
   * Parented under the requester's invoke_agent (looked up via runId) so
   * multi-agent workflows render hierarchically in Weave's Agents tab. The
   * subagent's own model/tool spans live in a separate trace (its own
   * harness emits them) — this span brackets the spawn-to-end window in the
   * requester's view.
   *
   * When `requesterRunId` is undefined, the spawn is intentionally root-level
   * (standalone session-mode subagent) and allowed. When it's set but the
   * requester's invoke_agent isn't active, the span is orphan-dropped to
   * avoid polluting Weave's Agents tab with a separate top-level "turn".
   */
  function startSubagentSpan(p: SubagentSpanStartParams): void {
    if (!spans || !invokeAgents || !resolvedCfg || stopped) return;
    if (subagentSpansBySubagentRunId.has(p.subagentRunId)) return;
    const attrs: Record<string, string | number | boolean> = {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": p.agentId,
      "weave.agent.id": p.agentId,
      "weave.subagent.mode": p.mode,
      "gen_ai.conversation.id": p.childSessionKey,
    };
    if (p.label) attrs["weave.agent.description"] = p.label;
    if (resolvedCfg.agentVersion) attrs["weave.agent.version"] = resolvedCfg.agentVersion;

    const parentSpan = p.requesterRunId
      ? invokeAgents.lookup({ by: "runId", value: p.requesterRunId })
      : undefined;
    const opened = spans.openSpan({
      spanName: `invoke_agent ${p.agentId}`,
      spanKind: SpanKind.INTERNAL,
      parentSpan,
      claimsParent: !!p.requesterRunId,
      allowRootless: false,
      attrs,
      startTimeMs: p.startTimeMs,
      debugContext: `requesterRunId=${p.requesterRunId ?? "<none>"} subagentRunId=${p.subagentRunId}`,
    });
    if (opened.kind !== "ok") return;
    setBoundedMap(subagentSpansBySubagentRunId, p.subagentRunId, opened.span, MAX_ACTIVE_SPANS);
  }

  function endSubagentSpan(p: SubagentSpanEndParams): void {
    const span = subagentSpansBySubagentRunId.get(p.subagentRunId);
    if (!span) return;
    if (p.outcome) span.setAttribute("weave.subagent.outcome", p.outcome);
    if (p.error) span.setAttribute("error.message", p.error);
    const isError = p.outcome && p.outcome !== "ok";
    span.setStatus({
      code: isError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      ...(p.error ? { message: p.error } : {}),
    });
    span.end(new Date(p.endTimeMs));
    subagentSpansBySubagentRunId.delete(p.subagentRunId);
  }

  /**
   * Add a `agent_end_summary` span event to the active invoke_agent. Captures
   * the final-state fallback when llm_output didn't fire (rare edge case:
   * harness ends without a successful model call). Emits success/error/duration
   * always; emits the final assistant text only when captureContent is enabled.
   */
  function emitAgentEndSummary(p: AgentEndSummaryParams): void {
    if (!invokeAgents || !resolvedCfg || stopped) return;
    const span = invokeAgents.lookup({ by: "runId", value: p.runId });
    if (!span) return;
    const attrs: Record<string, string | number | boolean> = {
      "weave.agent.success": p.success,
    };
    if (typeof p.durationMs === "number" && Number.isFinite(p.durationMs)) {
      attrs["weave.agent.duration_ms"] = Math.trunc(p.durationMs);
    }
    if (p.error) {
      attrs["weave.agent.error"] = p.error;
    }
    if (resolvedCfg.captureContent.enabled && p.lastAssistantMessage) {
      const sanitized = sanitizeAttrStringWithFlag(p.lastAssistantMessage);
      if (sanitized) {
        attrs["weave.agent.final_message"] = sanitized.value;
        if (sanitized.redactions > 0) {
          attrs["weave.redactions.count"] = sanitized.redactions;
        }
      }
    }
    span.addEvent("agent_end_summary", attrs);
  }

  /**
   * Emit a `message_received` span event on the active invoke_agent
   * (looked up by runId, falling back to sessionKey). Captures the inbound
   * boundary — what the user actually sent that triggered the run. Content
   * is only emitted when content capture is enabled.
   */
  function emitMessageReceived(p: MessageReceivedParams): void {
    if (!invokeAgents || !resolvedCfg || stopped) return;
    let span: Span | undefined;
    if (p.runId) span = invokeAgents.lookup({ by: "runId", value: p.runId });
    if (!span && p.sessionKey) {
      span = invokeAgents.lookup({ by: "sessionKey", value: p.sessionKey });
    }
    if (!span) return;
    const attrs: Record<string, string | number | boolean> = {
      "weave.message.from": p.from,
    };
    if (p.channel) attrs["weave.message.channel"] = p.channel;
    if (resolvedCfg.captureContent.enabled && p.content) {
      const sanitized = sanitizeAttrStringWithFlag(p.content);
      if (sanitized) {
        attrs["weave.message.content"] = sanitized.value;
        if (sanitized.redactions > 0) {
          attrs["weave.redactions.count"] = sanitized.redactions;
        }
      }
    }
    span.addEvent("message_received", attrs);
  }

  /**
   * Buffer or stamp a session_started span event. Buffers by sessionKey if no
   * invoke_agent is active for that key (typical case: session_start fires
   * before the first run of the session is born). Drained on the next
   * invoke_agent that starts with the matching sessionKey.
   */
  function emitSessionStart(p: SessionStartParams): void {
    if (!invokeAgents || !pending || !resolvedCfg || stopped) return;
    const span = invokeAgents.lookup({ by: "sessionKey", value: p.sessionKey });
    if (span) {
      const attrs: Record<string, string | number | boolean> = {};
      if (p.resumedFrom) attrs["weave.session.resumed_from"] = p.resumedFrom;
      span.addEvent("session_started", attrs);
      return;
    }
    pending.bufferSessionStart(p.sessionKey, { resumedFrom: p.resumedFrom });
  }

  /**
   * Stamp a session_ended span event on the invoke_agent for that sessionKey
   * if one is currently active. Best-effort: if the last run of the session
   * already finalized, the event is dropped (no anchor).
   */
  function emitSessionEnd(p: SessionEndParams): void {
    if (!invokeAgents || !resolvedCfg || stopped) return;
    const span = invokeAgents.lookup({ by: "sessionKey", value: p.sessionKey });
    if (!span) return;
    const attrs: Record<string, string | number | boolean> = {};
    if (p.reason) attrs["weave.session.reason"] = p.reason;
    if (typeof p.durationMs === "number" && Number.isFinite(p.durationMs)) {
      attrs["weave.session.duration_ms"] = Math.trunc(p.durationMs);
    }
    if (typeof p.messageCount === "number" && Number.isFinite(p.messageCount)) {
      attrs["weave.session.message_count"] = Math.trunc(p.messageCount);
    }
    span.addEvent("session_ended", attrs);
  }

  function getStatus(): WeaveStatusSnapshot {
    const snap: WeaveStatusSnapshot = {
      pluginVersion: PACKAGE_VERSION,
      lifecycle,
      lifecycleDetail,
      startedAt,
      activeSpans: spans?.size() ?? 0,
    };
    if (resolvedCfg) {
      snap.config = {
        entity: resolvedCfg.entity,
        project: resolvedCfg.project,
        serviceName: resolvedCfg.serviceName,
        agentVersion: resolvedCfg.agentVersion,
        flushIntervalMs: resolvedCfg.flushIntervalMs,
        captureSummary: resolvedCaptureSummary ?? "unknown",
        stripSenderWrapper: resolvedCfg.stripSenderWrapper,
        authSource: resolvedAuthSource ?? "unknown",
        uiUrl: resolvedUiUrl,
      };
    }
    return snap;
  }

  return {
    service,
    emitCompactionSpan,
    startSubagentSpan,
    endSubagentSpan,
    emitAgentEndSummary,
    emitMessageReceived,
    emitSessionStart,
    emitSessionEnd,
    flushChatSpan,
    getStatus,
  };

  function handleEvent(
    event: DiagnosticEventPayload,
    _meta: DiagnosticEventMetadata,
  ): void {
    if (!spans || !invokeAgents || !pending || !resolvedCfg) return;

    const traceId = event.trace?.traceId;
    if (!traceId) {
      // No trace context -> mapper will return skip; nothing to cache either.
      return;
    }

    // Learn sessionKey from any event that carries it; reuse it on subsequent
    // events in the same trace that drop the field (common for tool spans).
    const e = event as unknown as Record<string, unknown>;
    const eventSessionKey = nonEmptyString(e.sessionKey);
    if (eventSessionKey) {
      invokeAgents.learnSessionKey(traceId, eventSessionKey);
    }

    // Side-channel events attach to the active invoke_agent rather than
    // producing their own span. Handle these BEFORE the mapper so we can
    // short-circuit cleanly.
    if (event.type === "model.usage") {
      handleModelUsage(e, traceId);
      return;
    }
    if (event.type === "tool.loop") {
      handleToolLoop(e, traceId);
      return;
    }
    if (event.type === "context.assembled") {
      handleContextAssembled(e, traceId);
      return;
    }
    if (event.type === "run.attempt") {
      handleRunAttempt(e);
      return;
    }

    const conversationIdHint = invokeAgents.sessionKeyForTrace(traceId);

    const result = mapDiagnosticEventToWeaveSpan(event, resolvedCfg, {
      hookState: params.hookState,
      conversationIdHint,
    });
    if (result.kind === "skip") return;

    noteTruncationsInAttrs?.(result.attrs);

    if (result.kind === "start") {
      const isInvokeAgent = result.spanName.startsWith("invoke_agent ");
      const parentSpan = result.openclawParentSpanId
        ? spans.get(result.openclawParentSpanId)
        : undefined;
      const opened = spans.openSpan({
        spanName: result.spanName,
        spanKind: result.spanKind,
        openclawSpanId: result.openclawSpanId,
        openclawParentSpanId: result.openclawParentSpanId,
        parentSpan,
        claimsParent: !!result.openclawParentSpanId,
        // invoke_agent is exempt from orphan-drop because its claimed parent
        // may live upstream in OpenClaw's harness layer we don't observe.
        // Child spans (chat / execute_tool / context_compacted / subagent)
        // always drop when their claimed parent isn't active.
        allowRootless: isInvokeAgent,
        attrs: result.attrs,
        startTimeMs: result.startTimeMs,
        debugContext: `traceId=${traceId} spanId=${result.openclawSpanId} parentSpanId=${result.openclawParentSpanId ?? "<none>"}`,
      });
      if (opened.kind !== "ok") return;
      if (debugTraceTree) spans.dumpTree(`start ${result.openclawSpanId}`);

      if (isInvokeAgent) {
        const eventRunId = nonEmptyString(e.runId);
        invokeAgents.register({
          span: opened.span,
          traceId,
          runId: eventRunId,
          sessionKey: eventSessionKey,
        });
        pending.hydrateInvokeAgentSpan({
          span: opened.span,
          traceId,
          sessionKey: eventSessionKey,
        });
      }
      return;
    }

    // result.kind === "finalize"
    //
    // Chat-span special case: OpenClaw's runtime fires `model.call.completed`
    // (async-queued diagnostic event via setImmediate) BEFORE the agent loop
    // fires the `llm_output` hook (which carries assistantTexts / lastAssistant
    // / usage). At model.call.completed time, hookState.llmOutputs[callId] is
    // empty, so the mapper has nothing to put in weave.output.messages /
    // weave.usage.* / weave.reasoning_content. Closing now would seal the
    // chat span with empty content.
    //
    // Fix: when model.call.completed fires for a chat span with a callId,
    // stash the finalize args keyed by callId and DON'T close. The `llm_output`
    // hook handler in index.ts calls `flushChatSpan(callId)` after writing to
    // hookState, which re-runs the mapper (now sees populated hookState) and
    // closes the span with the correct content.
    //
    // Safety nets: model.call.error fires without llm_output, so we close
    // immediately on error. Invoke_agent finalize flushes any orphan pending
    // chat closes for that trace. Teardown flushes everything remaining.
    if (event.type === "model.call.completed") {
      const callId = nonEmptyString(e.callId);
      if (callId) {
        pendingChatCloseByCallId.set(callId, {
          openclawSpanId: result.openclawSpanId,
          attrs: result.attrs,
          status: result.status,
          errorType: result.errorType,
          endTimeMs: result.endTimeMs,
          traceId,
          conversationIdHint,
          event,
        });
        return;
      }
      // No callId on event payload — can't pair with llm_output. Fall through
      // to immediate close so the span doesn't leak.
    }
    applyFinalize(result.openclawSpanId, result.attrs, result.status, result.errorType, result.endTimeMs, traceId);
  }

  /**
   * Re-finalize and close a chat span whose `model.call.completed` diagnostic
   * event was deferred. Called from index.ts's `llm_output` hook after
   * capturing the assistant content into hookState. Re-runs the mapper so
   * `weave.input.messages` / `weave.output.messages` / `weave.usage.*` /
   * `weave.reasoning_content` get built from the now-populated hookState.
   */
  function flushChatSpan(callId: string): void {
    if (!spans || !resolvedCfg) return;
    const pending = pendingChatCloseByCallId.get(callId);
    if (!pending) return;
    pendingChatCloseByCallId.delete(callId);
    const fresh = mapDiagnosticEventToWeaveSpan(pending.event, resolvedCfg, {
      hookState: params.hookState,
      conversationIdHint: pending.conversationIdHint,
    });
    const attrs =
      fresh.kind === "finalize" ? fresh.attrs : pending.attrs;
    applyFinalize(
      pending.openclawSpanId,
      attrs,
      pending.status,
      pending.errorType,
      pending.endTimeMs,
      pending.traceId,
    );
  }

  /** Force-close every chat span that was deferred but never flushed (e.g.
   *  llm_output never fired for some pending callId). Used on invoke_agent
   *  finalize and on teardown so spans don't leak. */
  function flushAllPendingChatSpans(traceId?: string): void {
    if (pendingChatCloseByCallId.size === 0) return;
    const toFlush: string[] = [];
    for (const [callId, p] of pendingChatCloseByCallId) {
      if (traceId === undefined || p.traceId === traceId) toFlush.push(callId);
    }
    for (const callId of toFlush) flushChatSpan(callId);
  }

  /** Shared finalize tail used by both immediate and deferred close paths. */
  function applyFinalize(
    openclawSpanId: string,
    attrs: Record<string, string | number | boolean>,
    status: "ok" | "error",
    errorType: string | undefined,
    endTimeMs: number,
    traceId: string,
  ): void {
    if (!spans || !invokeAgents || !pending) return;
    const exceptionEvent =
      status === "error"
        ? {
            name: errorType ?? "error",
            // Per OTel spec (`docs/general/recording-errors.md`): set status,
            // set error.type, AND record an exception event with
            // `exception.{type,message}`. Synthesised from the structured
            // fields since the diagnostic-event payload doesn't carry the
            // original throwable.
            message: synthesiseExceptionMessage(errorType, attrs),
          }
        : undefined;
    const closed = spans.closeSpan({
      openclawSpanId,
      endTimeMs,
      statusCode: status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      statusMessage: errorType,
      attrs,
      exception: exceptionEvent,
    });
    if (!closed) return;
    if (invokeAgents.lookup({ by: "traceId", value: traceId }) === closed) {
      // Stamp final running totals on the invoke_agent and clear per-trace
      // buckets. Unregister from every InvokeAgentIndex axis so post-finalize
      // side-channel events (run.attempt / message_received / agent_end /
      // session_end) become silent no-ops instead of addEvent'ing on a dead
      // span.
      pending.finalizeInvokeAgentSpan({ span: closed, traceId });
      invokeAgents.unregister(closed);
      invokeAgents.forgetSessionKey(traceId);
      // Force-flush any chat spans deferred for this trace whose llm_output
      // hook never fired (rare: agent loop errored out between
      // model.call.completed and runLlmOutput).
      flushAllPendingChatSpans(traceId);
    }
    if (debugTraceTree) spans.dumpTree(`finalize ${openclawSpanId}`);
  }

  /**
   * Accumulate cost + aggregate-token attrs from a model.usage event for
   * this trace. Cost is summed across multiple model.usage events; aggregate
   * usage and context numbers are merged. If an invoke_agent span already
   * exists for the trace, attrs are also written directly so they're visible
   * mid-flight; otherwise they're stamped when the invoke_agent eventually
   * starts (or, at the latest, when it finalizes).
   */
  function handleModelUsage(e: Record<string, unknown>, traceId: string): void {
    if (!invokeAgents || !pending) return;
    const cost = e.costUsd;
    let total: number | undefined;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      total = pending.addCost(traceId, cost);
    } else {
      total = pending.getCost(traceId);
    }
    const patch: Record<string, number> = {};
    const usage = e.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      collectInt(patch, "weave.usage.total.input_tokens", usage.input);
      collectInt(patch, "weave.usage.total.output_tokens", usage.output);
      collectInt(patch, "weave.usage.total.cache_read.input_tokens", usage.cacheRead);
      collectInt(
        patch,
        "weave.usage.total.cache_creation.input_tokens",
        usage.cacheWrite,
      );
      collectInt(patch, "weave.usage.total.tokens", usage.total);
    }
    const ctx = e.context as Record<string, unknown> | undefined;
    if (ctx && typeof ctx === "object") {
      collectInt(patch, "weave.context.budget_tokens", ctx.limit);
      collectInt(patch, "weave.context.used_tokens", ctx.used);
    }
    const merged =
      Object.keys(patch).length > 0
        ? pending.mergeUsage(traceId, patch)
        : pending.getUsage(traceId);
    const span = invokeAgents.lookup({ by: "traceId", value: traceId });
    if (span) {
      if (typeof total === "number" && Number.isFinite(total)) {
        span.setAttribute("weave.cost.usd", total);
      }
      if (merged) {
        for (const [k, v] of Object.entries(merged)) span.setAttribute(k, v);
      }
    }
  }

  /**
   * Capture context.assembled snapshot. Stamps on the active invoke_agent
   * span if one exists; otherwise buffers for replay when invoke_agent starts.
   */
  function handleContextAssembled(
    e: Record<string, unknown>,
    traceId: string,
  ): void {
    if (!invokeAgents || !pending) return;
    const snap: Record<string, number> = {};
    collectInt(snap, "weave.context.message_count", e.messageCount);
    collectInt(snap, "weave.context.history_text_chars", e.historyTextChars);
    collectInt(snap, "weave.context.history_image_blocks", e.historyImageBlocks);
    collectInt(snap, "weave.context.system_prompt_chars", e.systemPromptChars);
    collectInt(snap, "weave.context.prompt_chars", e.promptChars);
    collectInt(snap, "weave.context.prompt_images", e.promptImages);
    collectInt(snap, "weave.context.budget_tokens", e.contextTokenBudget);
    collectInt(snap, "weave.context.reserve_tokens", e.reserveTokens);
    if (Object.keys(snap).length === 0) return;
    pending.setContext(traceId, snap);
    const span = invokeAgents.lookup({ by: "traceId", value: traceId });
    if (span) {
      for (const [k, v] of Object.entries(snap)) span.setAttribute(k, v);
    }
  }

  /**
   * run.attempt indicates the harness is making attempt N of a run (auto-retry
   * path). Stamps a `run_attempt` span event on the invoke_agent with the
   * attempt number. Looked up by runId since the diagnostic event's trace
   * context may pre-date the harness.run.started for that attempt.
   */
  function handleRunAttempt(e: Record<string, unknown>): void {
    if (!invokeAgents) return;
    const runId = nonEmptyString(e.runId);
    if (!runId) return;
    const span = invokeAgents.lookup({ by: "runId", value: runId });
    if (!span) return;
    const attempt =
      typeof e.attempt === "number" && Number.isFinite(e.attempt)
        ? Math.trunc(e.attempt)
        : undefined;
    const attrs: Record<string, string | number | boolean> = {};
    if (attempt !== undefined) attrs["weave.run.attempt"] = attempt;
    span.addEvent("run_attempt", attrs);
  }

  /**
   * tool.loop is OpenClaw's loop-detector signal — a frequent agent failure
   * mode (model calls the same tool with the same args repeatedly without
   * making progress). Surface it as a span event on the active invoke_agent
   * so dashboards can search for it inline; don't fabricate a separate span.
   * Buffered if no invoke_agent span exists yet (sync vs async dispatch race).
   */
  function handleToolLoop(e: Record<string, unknown>, traceId: string): void {
    if (!invokeAgents || !pending) return;
    const attrs: Record<string, string | number | boolean> = {};
    if (typeof e.toolName === "string") attrs["gen_ai.tool.name"] = e.toolName;
    if (typeof e.level === "string") attrs["weave.loop.level"] = e.level;
    if (typeof e.action === "string") attrs["weave.loop.action"] = e.action;
    if (typeof e.detector === "string") attrs["weave.loop.detector"] = e.detector;
    if (typeof e.count === "number" && Number.isFinite(e.count)) {
      attrs["weave.loop.count"] = Math.trunc(e.count);
    }
    if (typeof e.message === "string") attrs["weave.loop.message"] = e.message;
    if (typeof e.pairedToolName === "string") {
      attrs["weave.loop.paired_tool_name"] = e.pairedToolName;
    }
    const span = invokeAgents.lookup({ by: "traceId", value: traceId });
    if (span) {
      span.addEvent("tool.loop", attrs);
      return;
    }
    pending.bufferToolLoop(traceId, { name: "tool.loop", attrs });
  }

  async function teardownInternal(): Promise<void> {
    try {
      unsubscribe?.();
    } catch {
      // ignore
    }
    unsubscribe = undefined;
    // Best-effort flush any chat spans that were deferred and never reached
    // their llm_output hook. After endAllRemaining() the SpanRegistry would
    // close them with empty content anyway; do this first so they ship with
    // whatever hookState managed to capture.
    flushAllPendingChatSpans();
    pendingChatCloseByCallId.clear();
    spans?.endAllRemaining();
    invokeAgents?.clear();
    pending?.clear();
    for (const span of subagentSpansBySubagentRunId.values()) {
      try {
        span.end();
      } catch {
        // ignore
      }
    }
    subagentSpansBySubagentRunId.clear();
    try {
      await flushOTel();
    } catch (err) {
      console.warn(`weave: flushOTel failed during stop(): ${formatErr(err)}`);
    }
    tracer = undefined;
    resolvedCfg = undefined;
    spans = undefined;
    invokeAgents = undefined;
    pending = undefined;
    debugLogger = undefined;
    noteTruncationsInAttrs = undefined;
  }
}

function collectInt(
  out: Record<string, number>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    out[key] = Math.trunc(value);
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Optional API-key lookup. Returns the resolved key + a source label, or
 * undefined if no config-supplied key. The SDK reads WANDB_API_KEY / .netrc
 * itself; this is only for the case where config (typed string or SecretRef)
 * supplies a key, in which case we push it into WANDB_API_KEY env before
 * calling init().
 */
async function resolveApiKeyMaybe(
  raw: RawWeavePluginConfig["apiKey"],
): Promise<{ value: string; source: string } | undefined> {
  if (!raw) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return { value: trimmed, source: "literal" };
  }
  // SecretRef path: resolve using the same logic as resolve-auth.ts.
  // SecretRef has { source: "env" | "file" | "exec", provider: string, id: string }.
  const ref = raw as SecretRef;
  if (ref.source === "env") {
    const value = process.env[ref.id]?.trim();
    if (!value) {
      throw new Error(`weave: SecretRef env var "${ref.id}" is unset or empty.`);
    }
    return { value, source: `env:${ref.id}` };
  }
  if (ref.source === "file") {
    const { readFile } = await import("node:fs/promises");
    let content: string;
    try {
      content = await readFile(ref.id, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      throw new Error(
        `weave: SecretRef file "${ref.id}" could not be read${code ? ` (${code})` : ""}.`,
      );
    }
    const value = content.trim();
    if (!value) {
      throw new Error(`weave: SecretRef file "${ref.id}" is empty.`);
    }
    return { value, source: `file:${ref.id}` };
  }
  throw new Error(
    `weave: SecretRef source "${(ref as SecretRef).source}" is not supported. Use "env" or "file".`,
  );
}

function clampFlushInterval(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_FLUSH_INTERVAL_MS;
  }
  return Math.max(MIN_FLUSH_INTERVAL_MS, Math.trunc(raw));
}

function formatErr(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return maskSecrets(raw);
}

/**
 * Build a human-readable exception message from the structured fields the
 * diagnostic event carried. Composed from `error.type` plus any of the
 * descriptive attributes the mapper attached. Empty fallback "" so the
 * exception event still carries an `exception.type` attribute even when no
 * descriptive context is available.
 */
function synthesiseExceptionMessage(
  errorType: string | undefined,
  attrs: Record<string, string | number | boolean>,
): string {
  const parts: string[] = [];
  if (errorType) parts.push(errorType);
  const phase = attrs["weave.harness.phase"];
  const failureKind = attrs["weave.failure.kind"];
  const denied = attrs["weave.tool.denied_reason"];
  const blockReason = attrs["weave.tool.block.reason"];
  if (typeof phase === "string" && phase.length > 0) parts.push(`phase=${phase}`);
  if (typeof failureKind === "string" && failureKind.length > 0) {
    parts.push(`failureKind=${failureKind}`);
  }
  if (typeof denied === "string" && denied.length > 0) parts.push(`denied=${denied}`);
  if (typeof blockReason === "string" && blockReason.length > 0) {
    parts.push(`reason=${blockReason}`);
  }
  return parts.join(" ");
}

/**
 * Defense-in-depth: scrub auth header values from any error string before it
 * reaches a logger. OTel exporters and HTTP paths can include their full
 * headers dict in error messages on malformed config — which would otherwise
 * leak the API key into ctx.logger.error.
 *
 * @internal exported for tests.
 */
export function maskSecrets(s: string): string {
  return s
    .replace(/(Authorization\s*[:=]\s*Basic\s+)\S+/gi, "$1<redacted>")
    .replace(
      /(['"]?wandb-api-key['"]?\s*[:=]\s*['"]?)[^'"\s,}]+/gi,
      "$1<redacted>",
    )
    .replace(
      /(['"]?api[_-]?key['"]?\s*[:=]\s*['"]?)[^'"\s,}]+/gi,
      "$1<redacted>",
    );
}
