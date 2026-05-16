// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { applyGenAiAliases, mapDiagnosticEventToWeaveSpan } from "./event-mapper.js";
import { buildExporterHeaders } from "./exporter-headers.js";
import { createExporterObserver } from "./exporter-observer.js";
import type { WeaveHookState } from "./hook-state.js";
import { sanitizeAttrString } from "./redact.js";
import { resolveWandbApiKey } from "./resolve-auth.js";
import { resolveWeaveEndpoint } from "./resolve-endpoint.js";
import {
  resolveContentCapture,
  type RawWeavePluginConfig,
  type ResolvedWeavePluginConfig,
} from "./types.js";

const PACKAGE_NAME = "weave-openclaw";
const PACKAGE_VERSION = "0.0.1";
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
 * Both Maps preserve insertion order, so eviction is FIFO — the oldest entry
 * is dropped first.
 */
const MAX_ACTIVE_SPANS = 4096;
const MAX_TRACE_SESSION_KEYS = 4096;

export type CreateWeaveServiceParams = {
  pluginConfig?: unknown;
  /**
   * Optional injected SpanExporter. When omitted, a real OTLP/HTTP-protobuf
   * exporter pointed at Weave is constructed from config. Tests use this to
   * substitute an `InMemorySpanExporter`.
   */
  spanExporter?: SpanExporter;
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
 * The service owns a *local* `BasicTracerProvider` that is never registered
 * as the OTel global. This is what lets us coexist with `diagnostics-otel`
 * (which calls `NodeSDK.start()` and would conflict with a second global).
 *
 * Returns the registrable plugin service plus a `emitCompactionSpan`
 * side-channel callback. Compaction has no matching diagnostic event, so the
 * plugin entry's `after_compaction` hook calls this directly to push a
 * one-shot `context_compacted` span (parented under the active invoke_agent
 * when its `openclawSpanId` is supplied).
 */
export function createWeaveService(
  params: CreateWeaveServiceParams,
): WeaveServiceWithCallbacks {
  let provider: BasicTracerProvider | undefined;
  let tracer: Tracer | undefined;
  let unsubscribe: (() => void) | undefined;
  let resolvedCfg: ResolvedWeavePluginConfig | undefined;
  /** OpenClaw-spanId -> live OTel Span (so children can resolve their parent). */
  const activeSpans = new Map<string, Span>();
  /** OpenClaw traceId -> sessionKey learned from any prior event in the trace. */
  const sessionKeysByTrace = new Map<string, string>();
  /**
   * OpenClaw traceId -> live invoke_agent root span. Used to attach side-channel
   * data (cost from model.usage, tool.loop span events) to the right run.
   * If multiple invoke_agent roots exist for the same trace, the most recent
   * wins — subsequent subagent invoke_agent spans are children, not roots.
   */
  const invokeAgentByTrace = new Map<string, Span>();
  /**
   * runId -> live invoke_agent root span. Used by subagent_spawned hook
   * (which only carries runId, not traceId) to find the requester's parent
   * span for linkage.
   */
  const invokeAgentByRunId = new Map<string, Span>();
  /** Subagent's own runId -> live OTel span tracking that subagent invocation. */
  const subagentSpansByRunId = new Map<string, Span>();
  /**
   * sessionKey -> live invoke_agent span. Used for session_start / session_end
   * hooks (which carry sessionKey, not runId or trace) so we can attach
   * session-lifecycle events to the right run. The plugin updates this on
   * invoke_agent start and clears on finalize.
   */
  const invokeAgentBySessionKey = new Map<string, Span>();
  /**
   * Buffered session_start events by sessionKey for stamping on the NEXT
   * invoke_agent that starts with that sessionKey (session_start typically
   * fires before the first run of a session is born).
   */
  const pendingSessionStartByKey = new Map<
    string,
    { resumedFrom?: string }
  >();
  /**
   * Cumulative cost in USD by traceId, accumulated from model.usage events.
   * Tracked independently of `invokeAgentByTrace` because side-channel events
   * (model.usage, tool.loop) can arrive before the invoke_agent span exists
   * if the runtime emits them before the queue drains the run.started event.
   * The cumulative is applied to the span on start (if pending) and on
   * finalize (always, as the authoritative final value).
   */
  const cumulativeCostByTrace = new Map<string, number>();
  /**
   * Latest aggregate-token totals from model.usage by traceId, applied to the
   * invoke_agent span on start (if pending) and on finalize.
   */
  const aggregateUsageByTrace = new Map<string, Record<string, number>>();
  /**
   * Buffered tool.loop events by traceId for the same async/sync ordering
   * reason as cost. Drained as span events when invoke_agent starts.
   */
  const pendingToolLoopsByTrace = new Map<
    string,
    Array<{ name: "tool.loop"; attrs: Record<string, string | number | boolean> }>
  >();
  /**
   * Latest context.assembled snapshot per traceId, applied to the invoke_agent
   * span on start (if pending) and refreshed mid-flight on every event.
   */
  const pendingContextByTrace = new Map<string, Record<string, number>>();
  let stopped = false;
  /** Read at start() time so env changes take effect on plugin reload. */
  let debugSpans = false;
  let debugTraceTree = false;
  /** Logger captured from ctx for use inside handleEvent (which isn't a closure over ctx). */
  let debugLogger: { debug: (msg: string) => void } | undefined;
  /**
   * Per-span metadata tracked alongside `activeSpans` so the trace-tree
   * debug dump can render parent/child structure (the OTel Span API doesn't
   * expose parentSpanId or name).
   */
  const spanMetaByOpenclawSpanId = new Map<
    string,
    { name: string; parentOpenclawSpanId?: string }
  >();

  const service: OpenClawPluginService = {
    id: "weave",
    async start(ctx) {
      // Defensive re-entrancy guard: if start() is called twice (e.g. plugin
      // reload) without an intervening stop(), tear down the prior state
      // first so we don't leak a subscription or a TracerProvider.
      if (unsubscribe || provider) {
        await teardownInternal();
      }

      stopped = false;
      const flags = parseDebugFlags(process.env.OPENCLAW_WEAVE_DEBUG);
      debugSpans = flags.spans;
      debugTraceTree = flags.traceTree;
      if (debugSpans || debugTraceTree) {
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
        ctx.logger.info("weave: disabled via config.enabled=false");
        return;
      }
      if (typeof raw.entity !== "string" || raw.entity.length === 0) {
        ctx.logger.error("weave: config.entity is required");
        return;
      }
      if (typeof raw.project !== "string" || raw.project.length === 0) {
        ctx.logger.error("weave: config.project is required");
        return;
      }

      let endpoint: string;
      let exporter: SpanExporter;
      let authSource = "injected-exporter";
      try {
        endpoint = resolveWeaveEndpoint(raw);
        if (params.spanExporter) {
          // Injected exporter is owned by the caller (typically a test).
          // Wrap it so our provider.shutdown() cannot shut it down — the
          // owner should manage that lifecycle.
          exporter = nonOwningExporter(params.spanExporter);
        } else {
          const auth = await resolveWandbApiKey(raw.apiKey);
          authSource = auth.source;
          const realExporter = new OTLPTraceExporter({
            url: endpoint,
            headers: buildExporterHeaders(auth.key, `${raw.entity}/${raw.project}`),
          });
          exporter = createExporterObserver(realExporter, {
            onWarn: (msg) => ctx.logger.warn(msg),
          });
        }
      } catch (err) {
        ctx.logger.error(`weave: configuration error: ${formatErr(err)}`);
        return;
      }

      const flushInterval = clampFlushInterval(raw.flushIntervalMs);
      const serviceName = raw.serviceName?.trim() || DEFAULT_SERVICE_NAME;
      const projectId = `${raw.entity}/${raw.project}`;

      const spanProcessor: SpanProcessor = new BatchSpanProcessor(exporter, {
        scheduledDelayMillis: flushInterval,
      });

      provider = new BasicTracerProvider({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: serviceName,
          [ATTR_SERVICE_VERSION]: PACKAGE_VERSION,
          // wandb.entity / wandb.project are accepted by the Weave Agents
          // ingest as an alternate routing path alongside the project_id
          // header — belt-and-suspenders for stripped headers and gives every
          // span queryable provenance.
          "wandb.entity": raw.entity,
          "wandb.project": raw.project,
        }),
        spanProcessors: [spanProcessor],
      });
      // Intentionally do NOT call provider.register() — keep this provider
      // local so we don't fight diagnostics-otel for the global TracerProvider.

      tracer = provider.getTracer(PACKAGE_NAME, PACKAGE_VERSION);

      const resolvedAgentVersion = resolveAgentVersion(raw.agentVersion);
      resolvedCfg = {
        entity: raw.entity,
        project: raw.project,
        endpoint,
        serviceName,
        agentName: raw.agentName,
        agentVersion: resolvedAgentVersion,
        agentDescription: raw.agentDescription,
        captureContent: resolveContentCapture(raw.captureContent),
        flushIntervalMs: flushInterval,
        stripSenderWrapper: raw.stripSenderWrapper === true,
        // Default ON — produces a v1 trace stream that downstream OTel
        // GenAI consumers (Datadog, Honeycomb, LangSmith, Langfuse) can
        // ingest without per-vendor remapping. Set false to halve the
        // attribute-storage cost on Weave-only deployments.
        emitGenAiAliases: raw.emitGenAiAliases !== false,
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

      const tier = raw.tier ?? "cloud";
      const captureFields: string[] = [];
      if (resolvedCfg.captureContent.inputMessages) captureFields.push("inputMessages");
      if (resolvedCfg.captureContent.outputMessages) captureFields.push("outputMessages");
      if (resolvedCfg.captureContent.toolArguments) captureFields.push("toolArguments");
      if (resolvedCfg.captureContent.toolResults) captureFields.push("toolResults");
      if (resolvedCfg.captureContent.systemInstructions) captureFields.push("systemInstructions");
      const captureSummary = captureFields.length === 0 ? "off" : captureFields.join(",");
      ctx.logger.info(`weave: exporting to ${endpoint}`);
      ctx.logger.info(
        `weave: project=${projectId} service=${serviceName} agentVersion=${resolvedAgentVersion} ` +
          `tier=${tier} auth=${authSource} flushIntervalMs=${flushInterval} ` +
          `emitGenAiAliases=${resolvedCfg.emitGenAiAliases} ` +
          `stripSenderWrapper=${resolvedCfg.stripSenderWrapper} ` +
          `captureContent=${captureSummary}`,
      );
    },

    async stop(ctx) {
      stopped = true;
      try {
        await teardownInternal();
      } catch (err) {
        ctx?.logger?.warn?.(`weave: shutdown error: ${formatErr(err)}`);
      }
    },
  };

  function emitCompactionSpan(p: CompactionSpanParams): void {
    if (!tracer || !resolvedCfg || stopped) return;
    let parentCtx = otelContext.active();
    let parentResolved = false;
    if (p.parentOpenclawSpanId) {
      const parentSpan = activeSpans.get(p.parentOpenclawSpanId);
      if (parentSpan) {
        parentCtx = trace.setSpan(parentCtx, parentSpan);
        parentResolved = true;
      }
    }
    // Orphan-drop: if a parent was claimed but not found, drop the span
    // rather than letting it become a root (which would show as its own
    // "turn" in Weave's Agents tab).
    if (p.parentOpenclawSpanId && !parentResolved) {
      debugLogger?.debug(
        `[weave debug] drop-orphan span=context_compacted parentOpenclawSpanId=${p.parentOpenclawSpanId} reason=parent-not-in-activeSpans`,
      );
      return;
    }
    const attrs: Record<string, string | number | boolean> = {
      "weave.operation.name": "context_compacted",
      "weave.agent.name": p.agentName ?? resolvedCfg.agentName ?? "openclaw",
      "weave.compaction.items_before": Math.max(0, Math.trunc(p.itemsBefore)),
      "weave.compaction.items_after": Math.max(0, Math.trunc(p.itemsAfter)),
    };
    if (resolvedCfg.agentVersion) attrs["weave.agent.version"] = resolvedCfg.agentVersion;
    if (p.conversationId) attrs["weave.conversation.id"] = p.conversationId;
    if (typeof p.tokenCount === "number") {
      attrs["weave.compaction.summary"] = `${p.itemsBefore} -> ${p.itemsAfter} (${p.tokenCount} tokens)`;
    } else {
      attrs["weave.compaction.summary"] = `${p.itemsBefore} -> ${p.itemsAfter}`;
    }
    if (resolvedCfg.emitGenAiAliases) applyGenAiAliases(attrs);
    const span = tracer.startSpan(
      "context_compacted",
      {
        kind: SpanKind.INTERNAL,
        attributes: attrs,
        startTime: new Date(p.startTimeMs),
      },
      parentCtx,
    );
    span.end(new Date(p.endTimeMs));
  }

  /**
   * Start a `invoke_agent <agentId>` span representing a subagent invocation.
   * Parented under the requester's invoke_agent (looked up via runId) so
   * multi-agent workflows render hierarchically in Weave's Agents tab.
   * The subagent's own model/tool spans land in a separate trace (its own
   * harness emits them) — this span just brackets the spawn-to-end window
   * in the requester's view.
   */
  function startSubagentSpan(p: SubagentSpanStartParams): void {
    if (!tracer || !resolvedCfg || stopped) return;
    if (subagentSpansByRunId.has(p.subagentRunId)) return;
    let parentCtx = otelContext.active();
    let parentResolved = false;
    if (p.requesterRunId) {
      const parentSpan = invokeAgentByRunId.get(p.requesterRunId);
      if (parentSpan) {
        parentCtx = trace.setSpan(parentCtx, parentSpan);
        parentResolved = true;
      }
    }
    // Orphan-drop: if the requester's invoke_agent isn't active, drop the
    // subagent span. Letting it become a root would pollute Weave's Agents
    // tab as a separate top-level "turn". (When p.requesterRunId is
    // undefined the spawn is intentionally root-level — allowed.)
    if (p.requesterRunId && !parentResolved) {
      debugLogger?.debug(
        `[weave debug] drop-orphan span=invoke_agent (subagent) requesterRunId=${p.requesterRunId} subagentRunId=${p.subagentRunId} reason=requester-invoke_agent-not-active`,
      );
      return;
    }
    const attrs: Record<string, string | number | boolean> = {
      "weave.operation.name": "invoke_agent",
      "weave.agent.name": p.agentId,
      "weave.agent.id": p.agentId,
      "weave.subagent.mode": p.mode,
      "weave.conversation.id": p.childSessionKey,
    };
    if (p.label) attrs["weave.agent.description"] = p.label;
    if (resolvedCfg.agentVersion) attrs["weave.agent.version"] = resolvedCfg.agentVersion;
    if (resolvedCfg.emitGenAiAliases) applyGenAiAliases(attrs);
    const span = tracer.startSpan(
      `invoke_agent ${p.agentId}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: attrs,
        startTime: new Date(p.startTimeMs),
      },
      parentCtx,
    );
    addBoundedMap(subagentSpansByRunId, p.subagentRunId, span, MAX_ACTIVE_SPANS);
  }

  function endSubagentSpan(p: SubagentSpanEndParams): void {
    const span = subagentSpansByRunId.get(p.subagentRunId);
    if (!span) return;
    if (p.outcome) span.setAttribute("weave.subagent.outcome", p.outcome);
    if (p.error) span.setAttribute("error.message", p.error);
    const isError = p.outcome && p.outcome !== "ok";
    span.setStatus({
      code: isError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      ...(p.error ? { message: p.error } : {}),
    });
    span.end(new Date(p.endTimeMs));
    subagentSpansByRunId.delete(p.subagentRunId);
  }

  /**
   * Add a `agent_end_summary` span event to the active invoke_agent. Captures
   * the final-state fallback when llm_output didn't fire (rare edge case:
   * harness ends without a successful model call). Emits success/error/duration
   * always; emits the final assistant text only when captureContent is enabled.
   */
  function emitAgentEndSummary(p: AgentEndSummaryParams): void {
    if (!tracer || !resolvedCfg || stopped) return;
    const span = invokeAgentByRunId.get(p.runId);
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
      const sanitized = sanitizeAttrString(p.lastAssistantMessage);
      if (sanitized) attrs["weave.agent.final_message"] = sanitized;
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
    if (!tracer || !resolvedCfg || stopped) return;
    let span: Span | undefined;
    if (p.runId) span = invokeAgentByRunId.get(p.runId);
    if (!span && p.sessionKey) span = invokeAgentBySessionKey.get(p.sessionKey);
    if (!span) return;
    const attrs: Record<string, string | number | boolean> = {
      "weave.message.from": p.from,
    };
    if (p.channel) attrs["weave.message.channel"] = p.channel;
    if (resolvedCfg.captureContent.enabled && p.content) {
      const sanitized = sanitizeAttrString(p.content);
      if (sanitized) attrs["weave.message.content"] = sanitized;
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
    if (!tracer || !resolvedCfg || stopped) return;
    const span = invokeAgentBySessionKey.get(p.sessionKey);
    if (span) {
      const attrs: Record<string, string | number | boolean> = {};
      if (p.resumedFrom) attrs["weave.session.resumed_from"] = p.resumedFrom;
      span.addEvent("session_started", attrs);
      return;
    }
    addBoundedMap(
      pendingSessionStartByKey,
      p.sessionKey,
      { resumedFrom: p.resumedFrom },
      MAX_TRACE_SESSION_KEYS,
    );
  }

  /**
   * Stamp a session_ended span event on the invoke_agent for that sessionKey
   * if one is currently active. Best-effort: if the last run of the session
   * already finalized, the event is dropped (no anchor).
   */
  function emitSessionEnd(p: SessionEndParams): void {
    if (!tracer || !resolvedCfg || stopped) return;
    const span = invokeAgentBySessionKey.get(p.sessionKey);
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

  return {
    service,
    emitCompactionSpan,
    startSubagentSpan,
    endSubagentSpan,
    emitAgentEndSummary,
    emitMessageReceived,
    emitSessionStart,
    emitSessionEnd,
  };

  function handleEvent(
    event: DiagnosticEventPayload,
    _meta: DiagnosticEventMetadata,
  ): void {
    if (!tracer || !resolvedCfg) return;

    const traceId = event.trace?.traceId;
    if (!traceId) {
      // No trace context -> mapper will return skip; nothing to cache either.
      return;
    }

    // Learn sessionKey from any event that carries it; reuse it on subsequent
    // events in the same trace that drop the field (common for tool spans).
    const eventSessionKey = (event as unknown as { sessionKey?: unknown }).sessionKey;
    if (typeof eventSessionKey === "string" && eventSessionKey.length > 0) {
      addBoundedMap(sessionKeysByTrace, traceId, eventSessionKey, MAX_TRACE_SESSION_KEYS);
    }

    // Side-channel events: model.usage and tool.loop attach to the active
    // invoke_agent rather than producing their own span. Handle these BEFORE
    // the mapper so we can short-circuit cleanly.
    if (event.type === "model.usage") {
      handleModelUsage(event as unknown as Record<string, unknown>, traceId);
      return;
    }
    if (event.type === "tool.loop") {
      handleToolLoop(event as unknown as Record<string, unknown>, traceId);
      return;
    }
    if (event.type === "context.assembled") {
      handleContextAssembled(event as unknown as Record<string, unknown>, traceId);
      return;
    }
    if (event.type === "run.attempt") {
      handleRunAttempt(event as unknown as Record<string, unknown>);
      return;
    }

    const conversationIdHint = sessionKeysByTrace.get(traceId);

    const result = mapDiagnosticEventToWeaveSpan(event, resolvedCfg, {
      hookState: params.hookState,
      conversationIdHint,
    });
    if (result.kind === "skip") return;

    if (result.kind === "start") {
      // Don't double-create if we somehow see two `started` events for the
      // same spanId (idempotent on duplicates).
      if (activeSpans.has(result.openclawSpanId)) return;

      let parentCtx = otelContext.active();
      let parentResolved = false;
      if (result.openclawParentSpanId) {
        const parentSpan = activeSpans.get(result.openclawParentSpanId);
        if (parentSpan) {
          parentCtx = trace.setSpan(parentCtx, parentSpan);
          parentResolved = true;
        }
      }

      const isInvokeAgent = result.spanName.startsWith("invoke_agent ");
      const claimsParent = !!result.openclawParentSpanId;
      // Defensive orphan-drop: a child span (chat / execute_tool / etc.)
      // that claims a parent but can't find it would otherwise be created
      // as its own trace root, which Weave's Agents tab renders as a
      // separate "turn" — making one agent run look like many. Drop it
      // instead. invoke_agent is exempt because it's a legitimate root.
      if (!isInvokeAgent && claimsParent && !parentResolved) {
        debugLogger?.debug(
          `[weave debug] drop-orphan span=${result.spanName} traceId=${traceId} spanId=${result.openclawSpanId} parentSpanId=${result.openclawParentSpanId} reason=parent-not-in-activeSpans`,
        );
        return;
      }

      debugLogger?.debug(
        `[weave debug] span-create name=${result.spanName} traceId=${traceId} spanId=${result.openclawSpanId} parentSpanId=${result.openclawParentSpanId ?? "<none>"} parentResolved=${parentResolved}`,
      );

      const span = tracer.startSpan(
        result.spanName,
        {
          kind: result.spanKind,
          attributes: result.attrs,
          startTime: new Date(result.startTimeMs),
        },
        parentCtx,
      );
      addBoundedMap(activeSpans, result.openclawSpanId, span, MAX_ACTIVE_SPANS);
      spanMetaByOpenclawSpanId.set(result.openclawSpanId, {
        name: result.spanName,
        parentOpenclawSpanId: result.openclawParentSpanId,
      });
      if (debugTraceTree) {
        dumpTraceTree(`start ${result.openclawSpanId}`);
      }
      // Track invoke_agent roots by traceId for cost / tool.loop attachment.
      if (result.spanName.startsWith("invoke_agent ")) {
        invokeAgentByTrace.set(traceId, span);
        const eventRunId = (event as Record<string, unknown>).runId;
        if (typeof eventRunId === "string" && eventRunId.length > 0) {
          addBoundedMap(invokeAgentByRunId, eventRunId, span, MAX_ACTIVE_SPANS);
        }
        const eventSessionKey = (event as Record<string, unknown>).sessionKey;
        if (typeof eventSessionKey === "string" && eventSessionKey.length > 0) {
          addBoundedMap(invokeAgentBySessionKey, eventSessionKey, span, MAX_ACTIVE_SPANS);
          // Drain pending session_start for this sessionKey.
          const pending = pendingSessionStartByKey.get(eventSessionKey);
          if (pending) {
            const evAttrs: Record<string, string | number | boolean> = {};
            if (pending.resumedFrom) {
              evAttrs["weave.session.resumed_from"] = pending.resumedFrom;
            }
            span.addEvent("session_started", evAttrs);
            pendingSessionStartByKey.delete(eventSessionKey);
          }
        }
        // Replay any side-channel data that arrived before this span existed.
        // model.usage / tool.loop dispatch synchronously, so a usage event for
        // a run can fire before downstream listeners observe the run.started
        // span (if a sync emitter races ahead in the same tick).
        const pendingCost = cumulativeCostByTrace.get(traceId);
        if (typeof pendingCost === "number" && Number.isFinite(pendingCost)) {
          span.setAttribute("weave.cost.usd", pendingCost);
        }
        const pendingUsage = aggregateUsageByTrace.get(traceId);
        if (pendingUsage) {
          for (const [k, v] of Object.entries(pendingUsage)) {
            span.setAttribute(k, v);
          }
        }
        const pendingLoops = pendingToolLoopsByTrace.get(traceId);
        if (pendingLoops) {
          for (const ev of pendingLoops) {
            span.addEvent(ev.name, ev.attrs);
          }
          pendingToolLoopsByTrace.delete(traceId);
        }
        const pendingContext = pendingContextByTrace.get(traceId);
        if (pendingContext) {
          for (const [k, v] of Object.entries(pendingContext)) {
            span.setAttribute(k, v);
          }
        }
      }
      return;
    }

    // result.kind === "finalize"
    const span = activeSpans.get(result.openclawSpanId);
    if (!span) {
      // Started before our subscription, or we already finalized this span.
      // Drop quietly to avoid log noise.
      return;
    }

    // If finalizing an invoke_agent, stamp the cumulative cost (if any
    // model.usage events landed on this trace) and clear ALL bookkeeping
    // maps that reference this span — otherwise post-finalize events
    // (run.attempt / message_received / agent_end / session_end) would
    // addEvent on a dead span.
    if (invokeAgentByTrace.get(traceId) === span) {
      const totalCost = cumulativeCostByTrace.get(traceId);
      if (typeof totalCost === "number" && Number.isFinite(totalCost)) {
        span.setAttribute("weave.cost.usd", totalCost);
      }
      invokeAgentByTrace.delete(traceId);
      cumulativeCostByTrace.delete(traceId);
      aggregateUsageByTrace.delete(traceId);
      pendingContextByTrace.delete(traceId);
      for (const [k, v] of invokeAgentByRunId) {
        if (v === span) invokeAgentByRunId.delete(k);
      }
      for (const [k, v] of invokeAgentBySessionKey) {
        if (v === span) invokeAgentBySessionKey.delete(k);
      }
    }

    if (Object.keys(result.attrs).length > 0) {
      span.setAttributes(result.attrs);
    }
    if (result.status === "error") {
      // Per OTel spec (`docs/general/recording-errors.md`): set status,
      // set error.type, AND record an exception event with
      // `exception.{type,message}`. The diagnostic-event payload carries
      // categorical info (errorType, failureKind, phase, deniedReason) but
      // not the original throwable — we synthesise an exception event from
      // the structured fields so OTel-aware UIs (Honeycomb's exceptions
      // tab, Datadog's error inspector) light up correctly.
      span.recordException({
        name: result.errorType ?? "error",
        message: synthesiseExceptionMessage(result.errorType, result.attrs),
      });
    }
    span.setStatus({
      code: result.status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      ...(result.errorType ? { message: result.errorType } : {}),
    });
    span.end(new Date(result.endTimeMs));
    activeSpans.delete(result.openclawSpanId);
    spanMetaByOpenclawSpanId.delete(result.openclawSpanId);

    if (debugTraceTree) {
      dumpTraceTree(`finalize ${result.openclawSpanId}`);
    }
  }

  /**
   * Accumulate cost + aggregate-token attrs from a model.usage event for
   * this trace. Cost is summed across multiple model.usage events. If an
   * invoke_agent span already exists for the trace, attrs are also written
   * directly so they're visible mid-flight; otherwise, they're stamped when
   * the invoke_agent eventually starts (or, at the latest, when it finalizes).
   */
  function handleModelUsage(e: Record<string, unknown>, traceId: string): void {
    const cost = e.costUsd;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      const prev = cumulativeCostByTrace.get(traceId) ?? 0;
      const total = prev + cost;
      addBoundedMap(cumulativeCostByTrace, traceId, total, MAX_TRACE_SESSION_KEYS);
    }
    const aggregate = aggregateUsageByTrace.get(traceId) ?? {};
    const usage = e.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      collectInt(aggregate, "weave.usage.total.input_tokens", usage.input);
      collectInt(aggregate, "weave.usage.total.output_tokens", usage.output);
      collectInt(aggregate, "weave.usage.total.cache_read.input_tokens", usage.cacheRead);
      collectInt(
        aggregate,
        "weave.usage.total.cache_creation.input_tokens",
        usage.cacheWrite,
      );
      collectInt(aggregate, "weave.usage.total.tokens", usage.total);
    }
    const ctx = e.context as Record<string, unknown> | undefined;
    if (ctx && typeof ctx === "object") {
      collectInt(aggregate, "weave.context.budget_tokens", ctx.limit);
      collectInt(aggregate, "weave.context.used_tokens", ctx.used);
    }
    if (Object.keys(aggregate).length > 0) {
      addBoundedMap(aggregateUsageByTrace, traceId, aggregate, MAX_TRACE_SESSION_KEYS);
    }
    // Mid-flight stamp if the span already exists.
    const span = invokeAgentByTrace.get(traceId);
    if (span) {
      const totalCost = cumulativeCostByTrace.get(traceId);
      if (typeof totalCost === "number" && Number.isFinite(totalCost)) {
        span.setAttribute("weave.cost.usd", totalCost);
      }
      for (const [k, v] of Object.entries(aggregate)) {
        span.setAttribute(k, v);
      }
    }
  }

  /**
   * Capture context.assembled snapshot. Stamps on the active invoke_agent
   * span if one exists; otherwise buffers for replay when invoke_agent starts
   * (same async/sync race protection as model.usage and tool.loop).
   */
  function handleContextAssembled(
    e: Record<string, unknown>,
    traceId: string,
  ): void {
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
    addBoundedMap(pendingContextByTrace, traceId, snap, MAX_TRACE_SESSION_KEYS);
    const span = invokeAgentByTrace.get(traceId);
    if (span) {
      for (const [k, v] of Object.entries(snap)) span.setAttribute(k, v);
    }
  }

  /**
   * run.attempt indicates that the harness is making attempt N of a run
   * (auto-retry path). Stamps `run_attempt` span event on the invoke_agent
   * with the attempt number. Looked up by runId since the diagnostic event's
   * trace context may pre-date the harness.run.started for that attempt.
   */
  /**
   * Render the active span set grouped by traceId, with indentation reflecting
   * parent linkage. Used by `OPENCLAW_WEAVE_DEBUG=trace-tree` to diagnose
   * structural issues like "this trace has 5 invoke_agents" or "tool span is
   * a sibling of invoke_agent instead of a descendant of chat".
   */
  function dumpTraceTree(reason: string): void {
    if (!debugLogger) return;
    if (activeSpans.size === 0) {
      debugLogger.debug(
        `[weave debug] trace-tree (after ${reason}): <empty>`,
      );
      return;
    }
    type Node = {
      openclawSpanId: string;
      name: string;
      parentOpenclawSpanId?: string;
      otelSpanId: string;
      otelParentSpanId?: string;
    };
    const byTrace = new Map<string, Node[]>();
    for (const [openclawSpanId, span] of activeSpans) {
      const meta = spanMetaByOpenclawSpanId.get(openclawSpanId) ?? {
        name: "?",
      };
      const ctxIds = span.spanContext();
      const node: Node = {
        openclawSpanId,
        name: meta.name,
        parentOpenclawSpanId: meta.parentOpenclawSpanId,
        otelSpanId: ctxIds.spanId,
      };
      const list = byTrace.get(ctxIds.traceId) ?? [];
      list.push(node);
      byTrace.set(ctxIds.traceId, list);
    }
    const lines: string[] = [
      `[weave debug] trace-tree (after ${reason}, ${activeSpans.size} active span${activeSpans.size === 1 ? "" : "s"}):`,
    ];
    for (const [traceId, nodes] of byTrace) {
      lines.push(`  trace=${traceId}`);
      const ids = new Set(nodes.map((n) => n.openclawSpanId));
      const childrenOf = new Map<string, Node[]>();
      const roots: Node[] = [];
      for (const n of nodes) {
        if (n.parentOpenclawSpanId && ids.has(n.parentOpenclawSpanId)) {
          const list = childrenOf.get(n.parentOpenclawSpanId) ?? [];
          list.push(n);
          childrenOf.set(n.parentOpenclawSpanId, list);
        } else {
          roots.push(n);
        }
      }
      const render = (n: Node, indent: number): void => {
        lines.push(
          `${" ".repeat(indent)}${n.name} [openclawSpanId=${n.openclawSpanId}${n.parentOpenclawSpanId ? `, claimedParent=${n.parentOpenclawSpanId}` : ""}]`,
        );
        for (const c of childrenOf.get(n.openclawSpanId) ?? []) {
          render(c, indent + 2);
        }
      };
      for (const r of roots) render(r, 4);
    }
    debugLogger.debug(lines.join("\n"));
  }

  function handleRunAttempt(e: Record<string, unknown>): void {
    const runId = typeof e.runId === "string" ? e.runId : undefined;
    if (!runId) return;
    const span = invokeAgentByRunId.get(runId);
    if (!span) return;
    const attempt = typeof e.attempt === "number" && Number.isFinite(e.attempt)
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
    const attrs: Record<string, string | number | boolean> = {};
    if (typeof e.toolName === "string") attrs["weave.tool.name"] = e.toolName;
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
    const span = invokeAgentByTrace.get(traceId);
    if (span) {
      span.addEvent("tool.loop", attrs);
      return;
    }
    // Buffer until invoke_agent starts.
    const pending = pendingToolLoopsByTrace.get(traceId) ?? [];
    pending.push({ name: "tool.loop", attrs });
    addBoundedMap(pendingToolLoopsByTrace, traceId, pending, MAX_TRACE_SESSION_KEYS);
  }

  async function teardownInternal(): Promise<void> {
    try {
      unsubscribe?.();
    } catch {
      // ignore
    }
    unsubscribe = undefined;
    for (const span of activeSpans.values()) {
      try {
        span.end();
      } catch {
        // ignore
      }
    }
    activeSpans.clear();
    spanMetaByOpenclawSpanId.clear();
    sessionKeysByTrace.clear();
    invokeAgentByTrace.clear();
    invokeAgentByRunId.clear();
    cumulativeCostByTrace.clear();
    aggregateUsageByTrace.clear();
    pendingToolLoopsByTrace.clear();
    pendingContextByTrace.clear();
    invokeAgentBySessionKey.clear();
    pendingSessionStartByKey.clear();
    for (const span of subagentSpansByRunId.values()) {
      try {
        span.end();
      } catch {
        // ignore
      }
    }
    subagentSpansByRunId.clear();
    try {
      await provider?.shutdown();
    } catch {
      // ignore
    }
    provider = undefined;
    tracer = undefined;
    resolvedCfg = undefined;
    debugLogger = undefined;
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

/**
 * Wrap a caller-owned SpanExporter so our provider.shutdown() can't terminate
 * it. The wrapper forwards export/forceFlush but turns shutdown into a no-op.
 * Used when the caller injected an exporter (typically a test using
 * InMemorySpanExporter); we still need spans to flush during our shutdown,
 * but we must not put the caller's exporter into a stopped state.
 */
function nonOwningExporter(inner: SpanExporter): SpanExporter {
  return {
    export: inner.export.bind(inner),
    shutdown: async () => {},
    ...(inner.forceFlush
      ? { forceFlush: inner.forceFlush.bind(inner) }
      : {}),
  };
}

/**
 * Set a key on a Map with FIFO size bound. If the Map is at capacity AND the
 * key is new, the oldest entry (first-inserted) is evicted before insert.
 * Maps in JS preserve insertion order, so this is O(1).
 */
function addBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  if (map.size >= cap && !map.has(key)) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
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
 * reaches a logger. The OTLPTraceExporter constructor (and similar paths) can
 * include their full headers dict in error messages on malformed config —
 * which would otherwise leak the API key into ctx.logger.error.
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
