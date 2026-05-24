// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { SpanKind } from "@opentelemetry/api";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { stableAgentId } from "./agent-id.js";
import type { WeaveHookState } from "./hook-state.js";
import { lookupLlm, lookupToolCall } from "./hook-state.js";
import { detectOutputType } from "./output-type.js";
import {
  sanitizeAttrJson,
  sanitizeAttrJsonWithFlag,
  sanitizeAttrString,
  sanitizeAttrStringWithFlag,
  type SanitizedWithFlag,
} from "./redact.js";
import type { ResolvedWeavePluginConfig } from "./types.js";

export type WeaveAttrValue = string | number | boolean;
export type WeaveAttrs = Record<string, WeaveAttrValue>;


/**
 * Result of mapping a single diagnostic event to a Weave span operation.
 *
 * - "start": create a new OTel span, store under `openclawSpanId`.
 * - "finalize": look up the span by `openclawSpanId`, set attrs, end with status.
 * - "skip": event isn't relevant or has no trusted trace context.
 */
export type MapResult =
  | {
      kind: "start";
      spanName: string;
      spanKind: SpanKind;
      openclawSpanId: string;
      openclawParentSpanId?: string;
      attrs: WeaveAttrs;
      startTimeMs: number;
    }
  | {
      kind: "finalize";
      openclawSpanId: string;
      attrs: WeaveAttrs;
      status: "ok" | "error";
      errorType?: string;
      endTimeMs: number;
    }
  | { kind: "skip"; reason: string };

const SKIP_NO_TRACE: MapResult = {
  kind: "skip",
  reason: "event has no trusted trace context",
};

export type MapperContext = {
  /** Optional hook-state cache; if absent, content/usage attrs are skipped. */
  hookState?: WeaveHookState;
  /**
   * Pre-resolved conversation id (typically the trace's sticky sessionKey) used
   * when the current event payload doesn't carry sessionKey.
   */
  conversationIdHint?: string;
};

/**
 * Map a single OpenClaw diagnostic event to a Weave span operation.
 *
 * Coverage:
 * - run.{started,completed}                       -> invoke_agent <agent>  (root)
 * - model.call.{started,completed,error}          -> chat <model>          (child of invoke)
 * - tool.execution.{started,completed,error,blocked} -> execute_tool <tool> (child of invoke)
 *
 * `harness.run.*` events are intentionally NOT mapped. The OpenClaw runtime
 * (`src/agents/harness/v2.ts`) emits `harness.run.started` without an explicit
 * trace context — runtime auto-generates a spanId from async context — but
 * emits `harness.run.completed` with `result.diagnosticTrace`, which carries
 * a different spanId. Span correlation by `trace.spanId` therefore breaks for
 * `harness.run.*` pairs and the invoke_agent root span never finalizes.
 *
 * `run.started` / `run.completed` from `src/agents/pi-embedded-runner/run/attempt.ts`
 * thread the same `diagnosticRunBase` through both emits, so they share a
 * spanId — and `model.call.*` / `tool.execution.*` events parent under
 * `run.started`'s spanId, so the full tree correlates cleanly.
 *
 * Tradeoff: pre-attempt errors (`harness.prepare` / `harness.start` throwing
 * before `runEmbeddedAttempt` runs) emit only `harness.run.error`, never
 * `run.*` — those rare bootstrap failures will not produce a Weave span.
 *
 * All other events return { kind: "skip" }.
 */
export function mapDiagnosticEventToWeaveSpan(
  event: DiagnosticEventPayload,
  cfg: ResolvedWeavePluginConfig,
  mctx: MapperContext = {},
): MapResult {
  const trace = event.trace;
  if (!trace?.spanId) {
    return SKIP_NO_TRACE;
  }

  // We treat the runtime payload as Record<string, unknown> for opportunistic
  // access to fields not exposed in the public type (e.g. inputMessages,
  // toolInput) — diagnostics-otel uses the same pattern.
  const e = event as unknown as Record<string, unknown>;

  // Resolve conversation id: prefer event-level sessionKey, then the
  // service-supplied hint (a per-trace sticky sessionKey learned from earlier
  // events in this trace), then fall back to runId. The hint MUST beat runId
  // so a child event lacking sessionKey still groups under the parent's
  // sessionKey rather than a per-attempt id.
  const conversationId =
    asString(e.sessionKey) ?? mctx.conversationIdHint ?? asString(e.runId);

  let result: MapResult;
  switch (event.type) {
    case "run.started":
      result = startInvokeAgent(event, e, cfg, trace, conversationId);
      break;
    case "run.completed":
      result = finalizeRun(event, e, trace);
      break;
    case "model.call.started":
      result = startChat(event, e, cfg, trace, conversationId);
      break;
    case "model.call.completed":
      result = finalizeChat(event, e, cfg, mctx, "ok", undefined, trace);
      break;
    case "model.call.error":
      result = finalizeChat(event, e, cfg, mctx, "error", asString(e.errorCategory), trace);
      break;
    case "tool.execution.started":
      result = startTool(event, e, cfg, mctx, trace, conversationId);
      break;
    case "tool.execution.completed":
      result = finalizeTool(event, e, cfg, mctx, "ok", undefined, trace);
      break;
    case "tool.execution.error":
      result = finalizeTool(event, e, cfg, mctx, "error", asString(e.errorCategory), trace);
      break;
    case "tool.execution.blocked":
      result = finalizeBlockedTool(event, e, cfg, mctx, trace);
      break;
    default:
      return { kind: "skip", reason: `event type ${event.type} not mapped` };
  }
  return result;
}

/**
 * run.completed carries an `outcome` of `"completed" | "aborted" |
 * "timed_out" | "error"`. Only `"completed"` is success — everything else
 * marks the span as error so it renders red in the Agents tab. Aborted runs
 * surface their abort cause via errorCategory when present.
 */
function finalizeRun(
  event: DiagnosticEventPayload,
  e: Record<string, unknown>,
  trace: NonNullable<DiagnosticEventPayload["trace"]>,
): MapResult {
  const outcome = asString(e.outcome);
  if (outcome && outcome !== "completed") {
    return finalizeInvokeAgent(
      event,
      e,
      "error",
      asString(e.errorCategory) ?? outcome,
      trace,
    );
  }
  return finalizeInvokeAgent(event, e, "ok", undefined, trace);
}

// ---------------------------------------------------------------------------
// invoke_agent (one per harness/attempt)
// ---------------------------------------------------------------------------

function startInvokeAgent(
  event: DiagnosticEventPayload,
  e: Record<string, unknown>,
  cfg: ResolvedWeavePluginConfig,
  trace: NonNullable<DiagnosticEventPayload["trace"]>,
  conversationId: string | undefined,
): MapResult {
  const agent = resolveAgentName(cfg, e);
  return {
    kind: "start",
    spanName: `invoke_agent ${agent}`,
    spanKind: SpanKind.INTERNAL,
    openclawSpanId: trace.spanId!,
    openclawParentSpanId: trace.parentSpanId,
    startTimeMs: event.ts,
    attrs: {
      "gen_ai.operation.name": "invoke_agent",
      ...agentAttrs(cfg, e),
      ...conversationAttrs(conversationId, e),
      ...providerAttrs(e),
      ...modelAttrs(e),
    },
  };
}

function finalizeInvokeAgent(
  event: DiagnosticEventPayload,
  e: Record<string, unknown>,
  status: "ok" | "error",
  errorType: string | undefined,
  trace: NonNullable<DiagnosticEventPayload["trace"]>,
): MapResult {
  const attrs: WeaveAttrs = {};
  const outcome = asString(e.outcome);
  if (outcome) attrs["weave.outcome"] = outcome;
  const phase = asString(e.phase);
  if (phase) attrs["weave.harness.phase"] = phase;
  if (errorType) attrs["error.type"] = errorType;
  return {
    kind: "finalize",
    openclawSpanId: trace.spanId!,
    attrs,
    status,
    errorType,
    endTimeMs: event.ts,
  };
}

// ---------------------------------------------------------------------------
// chat (one per model call)
// ---------------------------------------------------------------------------

function startChat(
  event: DiagnosticEventPayload,
  e: Record<string, unknown>,
  cfg: ResolvedWeavePluginConfig,
  trace: NonNullable<DiagnosticEventPayload["trace"]>,
  conversationId: string | undefined,
): MapResult {
  const model = asString(e.model) ?? "unknown";
  return {
    kind: "start",
    spanName: `chat ${model}`,
    spanKind: SpanKind.CLIENT,
    openclawSpanId: trace.spanId!,
    openclawParentSpanId: trace.parentSpanId,
    startTimeMs: event.ts,
    attrs: {
      "gen_ai.operation.name": "chat",
      ...agentAttrs(cfg, e),
      ...conversationAttrs(conversationId, e),
      ...providerAttrs(e),
      ...modelAttrs(e),
      ...samplingAttrs(e),
    },
  };
}

function finalizeChat(
  event: DiagnosticEventPayload,
  e: Record<string, unknown>,
  cfg: ResolvedWeavePluginConfig,
  mctx: MapperContext,
  status: "ok" | "error",
  errorType: string | undefined,
  trace: NonNullable<DiagnosticEventPayload["trace"]>,
): MapResult {
  const attrs: WeaveAttrs = {};
  const callId = asString(e.callId);
  const runId = asString(e.runId);

  // Attribute usage from llm_output hook (preferred — has full token data),
  // falling back to event payload fields if present.
  const llm = mctx.hookState ? lookupLlm(mctx.hookState, callId, runId) : {};
  const usageFromHook = llm.output?.usage;
  if (usageFromHook) {
    assignInt(attrs, "gen_ai.usage.input_tokens", usageFromHook.input);
    assignInt(attrs, "gen_ai.usage.output_tokens", usageFromHook.output);
    assignInt(attrs, "gen_ai.usage.cache_read.input_tokens", usageFromHook.cacheRead);
    assignInt(attrs, "gen_ai.usage.cache_creation.input_tokens", usageFromHook.cacheWrite);
    assignInt(attrs, "gen_ai.usage.reasoning.output_tokens", usageFromHook.reasoning);
  } else {
    const usage = (e.usage ?? null) as Record<string, unknown> | null;
    if (usage) {
      assignInt(attrs, "gen_ai.usage.input_tokens", usage.input);
      assignInt(attrs, "gen_ai.usage.output_tokens", usage.output);
      assignInt(attrs, "gen_ai.usage.cache_read.input_tokens", usage.cacheRead);
      assignInt(attrs, "gen_ai.usage.cache_creation.input_tokens", usage.cacheWrite);
      assignInt(attrs, "gen_ai.usage.reasoning.output_tokens", usage.reasoning);
    } else {
      assignInt(attrs, "gen_ai.usage.input_tokens", e.inputTokens);
      assignInt(attrs, "gen_ai.usage.output_tokens", e.outputTokens);
    }
  }

  const responseId = asString(e.responseId) ?? asString(e.upstreamRequestIdHash);
  if (responseId) attrs["weave.response.id"] = responseId;

  const responseModel = asString(e.responseModel) ?? asString(e.model);
  if (responseModel) attrs["gen_ai.response.model"] = responseModel;

  // Top-level finish reasons for Weave's `finish_reasons` column and OTel's
  // `gen_ai.response.finish_reasons` (a string[] per the registry). Source
  // is the same provider field we put in per-message finish_reason — kept
  // canonical at the chat-span level so dashboards can group/filter on it
  // without parsing message arrays. Per-message finish_reason still rides
  // inside the output messages JSON.
  const finishReason = pickFinishReason(
    llm.output?.lastAssistant && typeof llm.output.lastAssistant === "object"
      ? (llm.output.lastAssistant as Record<string, unknown>)
      : undefined,
    e,
  );
  if (finishReason) {
    const arr = sanitizeAttrJson([finishReason]);
    if (arr) attrs["gen_ai.response.finish_reasons"] = arr;
  }

  // Streaming time-to-first-byte from the model.call.completed payload.
  // Surfaces in the chat-view latency column.
  assignInt(attrs, "weave.latency.time_to_first_byte_ms", e.timeToFirstByteMs);

  // Detected modality from lastAssistant content parts. Maps to Weave's
  // strict 5-value enum (`""|"text"|"json"|"image"|"speech"`). Per OTel
  // semconv, omit when unknown — empty-string emission was previously
  // emitted as a v0.2.x ergonomics choice but it pollutes the modality
  // filter. detectOutputType() now returns undefined when modality is
  // genuinely unknown.
  const outputType = detectOutputType(llm.output?.lastAssistant);
  if (outputType) attrs["gen_ai.output.type"] = outputType;

  // Content: prefer hook-captured prompt/completion. Falls back to opportunistic
  // event-payload fields if a future internal event carries them. When the 8KiB
  // clamp triggers, emit a sibling boolean flag so dashboards can filter for
  // truncated traces without string-matching the inline marker.
  let phaseRedactions = 0;
  if (cfg.captureContent.enabled) {
    if (cfg.captureContent.inputMessages) {
      const r = buildInputMessagesWithFlag(llm.input, e, cfg);
      if (r) {
        attrs["gen_ai.input.messages"] = r.value;
        if (r.truncated) attrs["weave.input.messages_truncated"] = true;
        phaseRedactions += r.redactions;
      }
    }
    if (cfg.captureContent.outputMessages) {
      const r = buildOutputMessagesWithFlag(llm.output, e);
      if (r) {
        attrs["gen_ai.output.messages"] = r.value;
        if (r.truncated) attrs["weave.output.messages_truncated"] = true;
        phaseRedactions += r.redactions;
      }
    }
    if (cfg.captureContent.systemInstructions) {
      // Weave schema column is `system_instructions: list[str]` and the
      // server's `_normalize_system_instructions` happily wraps a plain
      // string into `[raw]` — but the canonical OTel form is a JSON array
      // (matches the registry's `gen_ai.system_instructions: any` and the
      // OTel events spec showing `["system text"]`). Emit as a JSON-encoded
      // single-element list so both normalizers agree.
      const sysText = llm.input?.systemPrompt ?? e.systemPrompt;
      if (typeof sysText === "string" && sysText.length > 0) {
        const r = sanitizeAttrJsonWithFlag([sysText]);
        if (r) {
          attrs["gen_ai.system_instructions"] = r.value;
          if (r.truncated) attrs["weave.system_instructions_truncated"] = true;
          phaseRedactions += r.redactions;
        }
      }
    }
    // Anthropic thinking blocks live as `{type:"thinking", thinking: "..."}`
    // entries in lastAssistant.content. Concatenate them as a flat string for
    // dashboards that surface attributes directly (LangSmith, Datadog, etc.).
    const reasoningContent = extractReasoningContent(llm.output?.lastAssistant);
    if (reasoningContent) {
      const r = sanitizeAttrStringWithFlag(reasoningContent);
      if (r) {
        attrs["weave.reasoning_content"] = r.value;
        if (r.truncated) attrs["weave.reasoning_content_truncated"] = true;
        phaseRedactions += r.redactions;
      }
    }
  }
  if (phaseRedactions > 0) attrs["weave.redactions.count"] = phaseRedactions;

  if (errorType) attrs["error.type"] = errorType;
  const failureKind = asString(e.failureKind);
  if (failureKind) attrs["weave.failure.kind"] = failureKind;

  return {
    kind: "finalize",
    openclawSpanId: trace.spanId!,
    attrs,
    status,
    errorType,
    endTimeMs: event.ts,
  };
}

// ---------------------------------------------------------------------------
// execute_tool (one per tool invocation)
// ---------------------------------------------------------------------------

function startTool(
  event: DiagnosticEventPayload,
  e: Record<string, unknown>,
  cfg: ResolvedWeavePluginConfig,
  mctx: MapperContext,
  trace: NonNullable<DiagnosticEventPayload["trace"]>,
  conversationId: string | undefined,
): MapResult {
  const toolName = asString(e.toolName) ?? "unknown";
  const callId = asString(e.toolCallId);
  const tool = mctx.hookState ? lookupToolCall(mctx.hookState, callId) : {};

  const attrs: WeaveAttrs = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": toolName,
    "weave.tool.type": asString(e.toolType) ?? "function",
    ...agentAttrs(cfg, e),
    ...conversationAttrs(conversationId, e),
    ...providerAttrs(e),
  };
  if (callId) attrs["gen_ai.tool.call.id"] = callId;
  const toolDescription = asString(e.toolDescription);
  if (toolDescription) attrs["weave.tool.description"] = toolDescription;

  if (cfg.captureContent.enabled && cfg.captureContent.toolArguments) {
    const args = tool.args?.params ?? e.toolInput ?? e.paramsSummary;
    const r = sanitizeAttrJsonWithFlag(args);
    if (r) {
      attrs["gen_ai.tool.call.arguments"] = r.value;
      if (r.truncated) attrs["weave.tool.call.arguments_truncated"] = true;
      if (r.redactions > 0) attrs["weave.redactions.count"] = r.redactions;
    }
  }

  return {
    kind: "start",
    spanName: `execute_tool ${toolName}`,
    spanKind: SpanKind.INTERNAL,
    openclawSpanId: trace.spanId!,
    openclawParentSpanId: trace.parentSpanId,
    startTimeMs: event.ts,
    attrs,
  };
}

function finalizeTool(
  event: DiagnosticEventPayload,
  e: Record<string, unknown>,
  cfg: ResolvedWeavePluginConfig,
  mctx: MapperContext,
  status: "ok" | "error",
  errorType: string | undefined,
  trace: NonNullable<DiagnosticEventPayload["trace"]>,
): MapResult {
  const attrs: WeaveAttrs = {};
  const callId = asString(e.toolCallId);
  const tool = mctx.hookState ? lookupToolCall(mctx.hookState, callId) : {};

  if (cfg.captureContent.enabled && cfg.captureContent.toolResults) {
    const result = tool.result?.result ?? e.toolOutput;
    const r = sanitizeAttrJsonWithFlag(result);
    if (r) {
      attrs["gen_ai.tool.call.result"] = r.value;
      if (r.truncated) attrs["weave.tool.call.result_truncated"] = true;
      if (r.redactions > 0) attrs["weave.redactions.count"] = r.redactions;
    }
  }
  if (errorType) attrs["error.type"] = errorType;
  const denied = asString(e.deniedReason);
  if (denied) attrs["weave.tool.denied_reason"] = denied;
  return {
    kind: "finalize",
    openclawSpanId: trace.spanId!,
    attrs,
    status,
    errorType,
    endTimeMs: event.ts,
  };
}

/**
 * tool.execution.blocked carries both `deniedReason` (rich, user-facing —
 * e.g. "policy:no_external_email") and `reason` (short category — e.g.
 * "policy"). Use deniedReason as errorType so the Agents tab error column
 * shows the actionable detail; otherwise fall back to the short reason.
 */
function finalizeBlockedTool(
  event: DiagnosticEventPayload,
  e: Record<string, unknown>,
  cfg: ResolvedWeavePluginConfig,
  mctx: MapperContext,
  trace: NonNullable<DiagnosticEventPayload["trace"]>,
): MapResult {
  const denied = asString(e.deniedReason);
  const reason = asString(e.reason);
  const errorType = denied ?? reason ?? "blocked";
  const result = finalizeTool(event, e, cfg, mctx, "error", errorType, trace);
  if (result.kind === "finalize" && reason && reason !== denied) {
    result.attrs["weave.tool.block.reason"] = reason;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Attribute builders
// ---------------------------------------------------------------------------

function agentAttrs(
  cfg: ResolvedWeavePluginConfig,
  e: Record<string, unknown>,
): WeaveAttrs {
  const out: WeaveAttrs = {};
  const name = resolveAgentName(cfg, e);
  out["gen_ai.agent.name"] = name;
  // weave.agent.id is a deterministic SHA-256(entity/project/harnessId) hash
  // (8-char hex prefix). Stable across display-name renames so Weave's
  // Agents tab Versions panel doesn't fork history when an agent gets a new
  // human label.
  const harness =
    asString(e.harnessId) ?? asString(e.pluginId) ?? asString(e.agentId);
  out["weave.agent.id"] = stableAgentId(cfg.entity, cfg.project, harness);
  if (cfg.agentVersion) out["weave.agent.version"] = cfg.agentVersion;
  if (cfg.agentDescription) out["weave.agent.description"] = cfg.agentDescription;
  return out;
}

function conversationAttrs(
  conversationId: string | undefined,
  e: Record<string, unknown>,
): WeaveAttrs {
  const out: WeaveAttrs = {};
  if (conversationId) out["gen_ai.conversation.id"] = conversationId;
  const channel = asString(e.channel);
  const chatId = asString(e.chatId);
  if (channel && chatId) {
    out["weave.conversation.name"] = `${channel}:${chatId}`;
  }
  return out;
}

function providerAttrs(e: Record<string, unknown>): WeaveAttrs {
  const provider = asString(e.provider);
  return provider ? { "gen_ai.provider.name": provider } : {};
}

function modelAttrs(e: Record<string, unknown>): WeaveAttrs {
  const model = asString(e.model);
  return model ? { "gen_ai.request.model": model } : {};
}

/**
 * Pull request sampling parameters from the model.call.started payload when
 * present. The diagnostic event type doesn't declare these, but the runtime
 * payload may carry them (the model_call_started hook does), and the gateway
 * sometimes opportunistically threads them onto the diagnostic event. Weave's
 * Agents tab filters/sorts on these — without them, debug/repro workflows
 * are crippled.
 */
function samplingAttrs(e: Record<string, unknown>): WeaveAttrs {
  const out: WeaveAttrs = {};
  // First-class fields: e.{temperature,top_p,max_tokens,...}
  assignFiniteNumber(out, "weave.request.temperature", e.temperature);
  assignFiniteNumber(out, "weave.request.top_p", e.topP ?? e.top_p);
  assignFiniteNumber(out, "weave.request.top_k", e.topK ?? e.top_k);
  assignInt(out, "weave.request.max_tokens", e.maxTokens ?? e.max_tokens);
  assignInt(out, "weave.request.seed", e.seed);
  assignInt(
    out,
    "weave.request.choice.count",
    e.choiceCount ?? e.choice_count ?? e.n,
  );
  assignFiniteNumber(
    out,
    "weave.request.frequency_penalty",
    e.frequencyPenalty ?? e.frequency_penalty,
  );
  assignFiniteNumber(
    out,
    "weave.request.presence_penalty",
    e.presencePenalty ?? e.presence_penalty,
  );
  const stops = e.stopSequences ?? e.stop_sequences ?? e.stop;
  if (Array.isArray(stops) && stops.length > 0 && stops.every((s) => typeof s === "string")) {
    const v = sanitizeAttrJson(stops);
    if (v) out["weave.request.stop_sequences"] = v;
  }
  // Some payloads nest under `requestParams` / `samplingParams` / `params`.
  const nested =
    (e.requestParams ?? e.samplingParams ?? e.params) as
      | Record<string, unknown>
      | undefined;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    if (out["weave.request.temperature"] === undefined) {
      assignFiniteNumber(out, "weave.request.temperature", nested.temperature);
    }
    if (out["weave.request.top_p"] === undefined) {
      assignFiniteNumber(out, "weave.request.top_p", nested.topP ?? nested.top_p);
    }
    if (out["weave.request.max_tokens"] === undefined) {
      assignInt(out, "weave.request.max_tokens", nested.maxTokens ?? nested.max_tokens);
    }
  }
  return out;
}

/**
 * Pull `weave.reasoning_content` out of an Anthropic-style `lastAssistant`
 * payload. The Anthropic content shape is an array of parts where reasoning
 * blocks are `{type: "thinking", thinking: "..."}` (or the OTel-mapped
 * `{type: "reasoning", content: "..."}` shape used in some providers).
 *
 * Returns the concatenated reasoning text, or undefined if no reasoning
 * blocks are present.
 */
function extractReasoningContent(lastAssistant: unknown): string | undefined {
  if (!lastAssistant || typeof lastAssistant !== "object") return undefined;
  const content = (lastAssistant as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const out: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const t = typeof p.type === "string" ? p.type : "";
    if (t === "thinking" && typeof p.thinking === "string") {
      out.push(p.thinking);
    } else if (t === "reasoning" && typeof p.content === "string") {
      out.push(p.content);
    }
  }
  return out.length > 0 ? out.join("\n\n") : undefined;
}

function resolveAgentName(
  cfg: ResolvedWeavePluginConfig,
  e: Record<string, unknown>,
): string {
  return (
    cfg.agentName ??
    asString(e.harnessId) ??
    asString(e.pluginId) ??
    asString(e.agentId) ??
    "openclaw"
  );
}

// ---------------------------------------------------------------------------
// Message construction
// ---------------------------------------------------------------------------
//
// Two contracts must both be satisfied:
//
// 1. Weave clickhouse insert (`weave/trace_server/agents/helpers.py:
//    _message_dict_to_tuple`) does strict-key access on `role`, `content`,
//    `finish_reason`. Missing any → KeyError → the whole array is dropped.
//    So every emitted message MUST carry all three keys (empty string OK).
//
// 2. OpenTelemetry GenAI semconv (`gen_ai.input.messages` /
//    `gen_ai.output.messages` JSON schemas) requires `role` ∈
//    {system, user, assistant, tool} and a `parts: [...]` array. Each
//    part is one of: TextPart `{type:"text", content}`, ToolCallRequestPart
//    `{type:"tool_call", id, name, arguments}`, ToolCallResponsePart
//    `{type:"tool_call_response", id, response}`, ReasoningPart
//    `{type:"reasoning", content}`. Output messages additionally require
//    `finish_reason`. Schema sources:
//      https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-input-messages.json
//      https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-output-messages.json
//
// We satisfy both by emitting `{role, content, finish_reason, parts}`. The
// Weave server reads `role|content|finish_reason`; OTel-aware consumers
// (Datadog, LangSmith, Honeycomb, etc.) read `role|parts|finish_reason`.

type WeavePart =
  | { type: "text"; content: string }
  | { type: "tool_call"; id?: string; name: string; arguments?: unknown }
  | { type: "tool_call_response"; id?: string; response: unknown }
  | { type: "reasoning"; content: string };

type WeaveMessage = {
  role: string;
  content: string;
  finish_reason: string;
  parts?: WeavePart[];
};

/**
 * Map non-standard internal roles to OTel/OpenAI canonical roles.
 * - `toolResult` (pi-ai internal) → `tool` (OpenAI/OTel canonical).
 * - `system|user|assistant|tool` pass through unchanged.
 *
 * `custom` is NOT remapped — it's filtered upstream in
 * `buildInputMessagesWithFlag`, since OpenClaw's `custom` messages are
 * runtime/extension scaffolding the model never directly saw.
 *
 * Anything else is normalized to "user" as a defensive fallback.
 */
function normalizeRole(role: string | undefined): string {
  if (!role) return "user";
  if (role === "toolResult") return "tool";
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
    return role;
  }
  return "user";
}

/**
 * Internal pi-agent-core / OpenClaw `customType` values that ride on
 * `role: "custom"` AgentMessages. None of these are part of the LLM's view —
 * the runtime's `convertToLlm()` either inlines them into adjacent user turns
 * or filters them out before each provider call. Emitting them in
 * `weave.input.messages` (a) doesn't reflect what the model saw and (b)
 * pollutes the Weave Agents-tab chat view with internal scaffolding.
 *
 * Keep the *raw payload* available in `lastAssistant`/`historyMessages` for
 * debug-trace plugins; just don't surface them as conversation messages.
 *
 * Source paths in OpenClaw runtime:
 *   - `openclaw.runtime-context` → src/agents/pi-embedded-runner/run/runtime-context-prompt.ts
 *   - `openclaw.cache-ttl`       → src/agents/pi-embedded-runner/cache-ttl.ts
 *   - `model-snapshot`           → src/agents/pi-embedded-runner/replay-history.ts
 *   - `google-turn-ordering-bootstrap` → src/plugins/provider-replay-helpers.ts
 *   - `[sessions_yield interrupt]`     → src/agents/pi-embedded-runner/run/attempt.sessions-yield.ts
 *   - `compactionSummary`        → declared in src/types/pi-agent-core.d.ts
 */
const FILTERED_CUSTOM_TYPES = new Set([
  "openclaw.runtime-context",
  "openclaw.cache-ttl",
  "model-snapshot",
  "google-turn-ordering-bootstrap",
  "[sessions_yield interrupt]",
  "compactionSummary",
]);

/**
 * Decide whether a `role: "custom"` AgentMessage should be dropped from
 * `weave.input.messages`. Returns true for known internal scaffolding and
 * for the "Conversation info / Sender (untrusted metadata)" inbound-meta
 * blocks (which the model sees prepended into the user message body, not as
 * a separate turn). Returns false (keep) only when we can't identify the
 * customType — better to over-show than silently drop unfamiliar data.
 */
function shouldDropCustomMessage(raw: Record<string, unknown>): boolean {
  const customType =
    typeof raw.customType === "string" ? raw.customType : undefined;
  if (customType && FILTERED_CUSTOM_TYPES.has(customType)) return true;
  // Inbound-meta blocks have a recognizable content prefix — drop them so
  // the chat view isn't dominated by per-turn `Conversation info ...` JSON
  // blocks. The same metadata is also present prefixed onto the next user
  // message, which is what the model actually saw.
  const content = typeof raw.content === "string" ? raw.content : "";
  if (
    content.startsWith("Conversation info (untrusted metadata)") ||
    content.startsWith("Sender (untrusted metadata)")
  ) {
    return true;
  }
  return false;
}

/**
 * OpenClaw wraps inbound user messages with one or two metadata blocks
 * (`Conversation info` + `Sender`) followed by a `[<dayname> <date>
 * <time> <tz>]` timestamp marker, all prepended to the user's actual text:
 *
 *     Conversation info (untrusted metadata):
 *     ```json
 *     { ... }
 *     ```
 *
 *     Sender (untrusted metadata):
 *     ```json
 *     { ... }
 *     ```
 *     [Sun 2026-05-03 22:11 PDT] what's a private officiant
 *
 * The wrappers are scaffolding the model needs in-band but operators reading
 * traces may or may not want to see — they are long (~500 chars typical),
 * which makes the Weave chat-view harder to scan, but they also carry the
 * exact bytes the LLM received and can hide prompt-injection or scaffolding
 * bugs if elided.
 *
 * `stripWrapperPrefix` matches all three optional blocks and returns
 * everything after them. Application is gated by `cfg.stripSenderWrapper`
 * (default false → keep the wrapper, faithful to OTel `gen_ai.input.messages`
 * semantics; set true → strip for cleaner chat-view at the cost of
 * fidelity). Applies symmetrically to both `historyMessages` user turns
 * and the in-flight `input.prompt`.
 */
const WRAPPER_PREFIX_RE = new RegExp(
  // optional Conversation-info block
  "^(?:Conversation info \\(untrusted metadata\\):\\s*```json\\s*\\{[\\s\\S]*?\\}\\s*```\\s*\\n*)?" +
    // optional Sender block (either with code fences OR the older raw-JSON form)
    "(?:Sender \\(untrusted metadata\\):\\s*(?:```json\\s*)?\\{[\\s\\S]*?\\}(?:\\s*```)?\\s*\\n*)?" +
    // optional [Day YYYY-MM-DD HH:MM TZ] timestamp line
    "(?:\\[[A-Za-z]{3}\\s+\\d{4}-\\d{2}-\\d{2}\\s+\\d{1,2}:\\d{2}(?:\\s+[A-Z]{2,4})?\\]\\s*)?",
);

/**
 * Strip OpenClaw's metadata-wrapper prefix from a user-message body.
 * Always safe to call — returns input unchanged when no wrapper is detected.
 *
 * @internal exported for tests.
 */
export function stripWrapperPrefix(text: string): string {
  if (!text) return text;
  const m = WRAPPER_PREFIX_RE.exec(text);
  if (m && m[0].length > 0) return text.slice(m[0].length);
  return text;
}

function maybeStripSenderWrapper(text: string, strip: boolean): string {
  if (!strip || !text) return text;
  return stripWrapperPrefix(text);
}

function buildInputMessagesWithFlag(
  input: { systemPrompt?: string; prompt: string; historyMessages?: unknown[] } | undefined,
  e: Record<string, unknown>,
  cfg: ResolvedWeavePluginConfig,
): SanitizedWithFlag | undefined {
  // Conversation messages ONLY — system prompt is emitted separately as
  // `weave.system_instructions` so the chat view renders user/assistant turns
  // cleanly. Mixing system into input.messages causes the long system block
  // to swamp the user message in the per-trace chat panel.
  if (input) {
    const messages: WeaveMessage[] = [];
    if (Array.isArray(input.historyMessages)) {
      for (const h of input.historyMessages) {
        if (!h || typeof h !== "object" || Array.isArray(h)) continue;
        const raw = h as Record<string, unknown>;
        const rawRole = typeof raw.role === "string" ? raw.role : undefined;
        // Filter pi-agent-core `role: "custom"` messages whose customType
        // identifies them as runtime/extension scaffolding the model never
        // saw as a distinct turn. See `FILTERED_CUSTOM_TYPES`.
        if (rawRole === "custom" && shouldDropCustomMessage(raw)) continue;
        // Drop any system messages mixed into history; they belong in
        // system_instructions, not the conversation list.
        if (rawRole === "system") continue;

        const m = coerceMessage(raw);
        if (!m) continue;
        if (m.role === "user") {
          m.content = maybeStripSenderWrapper(m.content, cfg.stripSenderWrapper);
          // Refresh the text part to mirror the stripped content so OTel
          // consumers reading `parts` see the same text as `content`.
          syncTextPart(m);
        }
        messages.push(m);
      }
    }
    if (input.prompt) {
      // The in-flight user turn. Whether to strip OpenClaw's wrapper
      // (`Conversation info` / `Sender (untrusted metadata)` / `[timestamp]`)
      // is gated by `cfg.stripSenderWrapper` — same flag that gates
      // historyMessages stripping, so both ride one consistent policy.
      //
      // Default (false) is raw, matching what the LLM saw. That's the
      // OTel-conforming choice: `gen_ai.input.messages` (and its alias
      // `weave.input.messages`) is the messages-sent-to-the-model attribute,
      // and every other LLM-observability tool (Phoenix, Helicone, Langfuse,
      // LangSmith) follows that convention. Stripping is a UX-only opt-in
      // for operators who want a cleaner Weave chat-view rendering and are
      // willing to lose visibility into the wrapper (which can carry
      // prompt-injection attempts or scaffolding bugs).
      const promptText = maybeStripSenderWrapper(
        input.prompt,
        cfg.stripSenderWrapper,
      );
      messages.push({
        role: "user",
        content: promptText,
        finish_reason: "",
        parts: promptText ? [{ type: "text", content: promptText }] : [],
      });
    }
    if (messages.length > 0) {
      return sanitizeAttrJsonWithFlag(messages);
    }
  }
  return sanitizeAttrJsonWithFlag(e.inputMessages);
}

function buildOutputMessagesWithFlag(
  output: { assistantTexts?: string[]; lastAssistant?: unknown } | undefined,
  e: Record<string, unknown>,
): SanitizedWithFlag | undefined {
  if (output) {
    const texts = output.assistantTexts ?? [];
    const fallbackText = texts.join("\n");
    const la =
      output.lastAssistant && typeof output.lastAssistant === "object"
        ? (output.lastAssistant as Record<string, unknown>)
        : undefined;

    // Build OTel-canonical parts from provider-shaped content, falling back
    // to a single text part from `assistantTexts` when no structured payload
    // is available. Mirrors the schema at
    // https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-output-messages.json
    const parts = la?.content
      ? extractPartsFromProviderContent(la.content)
      : fallbackText
        ? [{ type: "text" as const, content: fallbackText }]
        : [];
    const content = collectTextFromParts(parts) || fallbackText;
    const finish = pickFinishReason(la, e) ?? "";

    const message: WeaveMessage = {
      role: "assistant",
      content,
      finish_reason: finish,
      parts,
    };

    if (content || parts.length > 0) {
      return sanitizeAttrJsonWithFlag([message]);
    }
  }
  return sanitizeAttrJsonWithFlag(e.outputMessages);
}

/**
 * Translate a provider-shaped `content` array (Anthropic / OpenAI / Google /
 * pi-ai variants) into the OTel-canonical `parts` array. Recognises:
 *   - `{type: "text", text}`              → TextPart
 *   - `{type: "text", content}`           → TextPart (already canonical)
 *   - plain string element                → TextPart
 *   - `{type: "thinking", thinking}`      → ReasoningPart  (Anthropic)
 *   - `{type: "reasoning", content}`      → ReasoningPart  (OTel canonical)
 *   - `{type: "tool_use", id, name, input}` → ToolCallRequestPart  (Anthropic)
 *   - `{type: "tool_call", id, name, arguments}` → ToolCallRequestPart  (OAI / OTel)
 *   - `{type: "tool_result", tool_use_id, content}` → ToolCallResponsePart  (Anthropic)
 *   - `{type: "tool_call_response", id, response}` → ToolCallResponsePart  (OTel canonical)
 * Anything else (image/audio/file) is dropped here — those are tracked via
 * `weave.output.type` modality detection rather than included as raw parts.
 */
function extractPartsFromProviderContent(content: unknown): WeavePart[] {
  if (!Array.isArray(content)) return [];
  const out: WeavePart[] = [];
  for (const p of content) {
    if (typeof p === "string") {
      if (p.length > 0) out.push({ type: "text", content: p });
      continue;
    }
    if (!p || typeof p !== "object") continue;
    const part = p as Record<string, unknown>;
    const t = typeof part.type === "string" ? part.type : "";
    if (t === "text") {
      const text =
        (typeof part.content === "string" && part.content) ||
        (typeof part.text === "string" && part.text) ||
        "";
      if (text) out.push({ type: "text", content: text });
    } else if (t === "thinking" && typeof part.thinking === "string") {
      out.push({ type: "reasoning", content: part.thinking });
    } else if (t === "reasoning" && typeof part.content === "string") {
      out.push({ type: "reasoning", content: part.content });
    } else if (t === "tool_use") {
      const name = typeof part.name === "string" ? part.name : "";
      if (name) {
        const id = typeof part.id === "string" ? part.id : undefined;
        out.push({
          type: "tool_call",
          ...(id ? { id } : {}),
          name,
          arguments: part.input ?? part.arguments,
        });
      }
    } else if (t === "tool_call") {
      const name = typeof part.name === "string" ? part.name : "";
      if (name) {
        const id = typeof part.id === "string" ? part.id : undefined;
        out.push({
          type: "tool_call",
          ...(id ? { id } : {}),
          name,
          arguments: part.arguments ?? part.input,
        });
      }
    } else if (t === "tool_result") {
      const id =
        typeof part.tool_use_id === "string"
          ? part.tool_use_id
          : typeof part.id === "string"
            ? part.id
            : undefined;
      out.push({
        type: "tool_call_response",
        ...(id ? { id } : {}),
        response: part.content ?? part.response,
      });
    } else if (t === "tool_call_response") {
      const id = typeof part.id === "string" ? part.id : undefined;
      out.push({
        type: "tool_call_response",
        ...(id ? { id } : {}),
        response: part.response ?? part.content,
      });
    }
  }
  return out;
}

function collectTextFromParts(parts: WeavePart[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === "text") out.push(p.content);
  }
  return out.join("\n");
}

/** Refresh a message's `parts` so any TextPart matches the (post-strip) `content`. */
function syncTextPart(m: WeaveMessage): void {
  if (!m.parts || m.parts.length === 0) {
    m.parts = m.content ? [{ type: "text", content: m.content }] : [];
    return;
  }
  let updated = false;
  for (let i = 0; i < m.parts.length; i++) {
    const p = m.parts[i];
    if (p && p.type === "text") {
      m.parts[i] = { type: "text", content: m.content };
      updated = true;
      break;
    }
  }
  if (!updated && m.content) {
    m.parts.unshift({ type: "text", content: m.content });
  }
}

/**
 * Resolve the per-message finish reason from provider fields or the
 * surrounding event payload. OTel canonical enum is
 * {stop, length, content_filter, tool_call, error} but free-form strings
 * are accepted; we don't remap to keep upstream context.
 */
function pickFinishReason(
  la: Record<string, unknown> | undefined,
  e: Record<string, unknown>,
): string | undefined {
  const sources = [
    la?.finish_reason,
    la?.stop_reason,
    e.finishReason,
    e.finish_reason,
    e.stopReason,
  ];
  for (const v of sources) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Coerce an arbitrary history-message value into a WeaveMessage. Handles
 * pi-ai's `toolResult` role (mapped to `tool`) and that role's
 * `(TextContent | ImageContent)[]` content shape. For everything else,
 * extracts text via `extractPartsFromProviderContent` and aggregates.
 */
function coerceMessage(value: unknown): WeaveMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const rawRole = typeof r.role === "string" ? r.role : undefined;
  const role = normalizeRole(rawRole);
  let content = asString(r.content) ?? "";
  let parts: WeavePart[] = [];

  if (role === "tool") {
    // pi-ai `ToolResultMessage`: `content: (TextContent | ImageContent)[]`
    // plus `toolCallId` (id) and `toolName` (name).
    const id =
      typeof r.toolCallId === "string"
        ? r.toolCallId
        : typeof r.tool_call_id === "string"
          ? r.tool_call_id
          : typeof r.id === "string"
            ? r.id
            : undefined;
    let response: unknown = r.content ?? r.response;
    let textBuf = "";
    if (typeof r.content === "string") {
      textBuf = r.content;
      response = r.content;
    } else if (Array.isArray(r.content)) {
      const sub = extractPartsFromProviderContent(r.content);
      textBuf = collectTextFromParts(sub);
    }
    parts = [
      {
        type: "tool_call_response",
        ...(id ? { id } : {}),
        response,
      },
    ];
    content = textBuf || content;
  } else if (Array.isArray(r.content)) {
    parts = extractPartsFromProviderContent(r.content);
    if (!content) content = collectTextFromParts(parts);
  } else if (content) {
    parts = [{ type: "text", content }];
  } else if (Array.isArray(r.parts)) {
    // Already-OTel-canonical input — pass through if shape matches.
    parts = extractPartsFromProviderContent(r.parts);
    if (!content) content = collectTextFromParts(parts);
  }

  // Assistant tool-call requests can live as siblings in pi-ai
  // `AssistantMessage` — `toolCalls?: [{toolCallId, toolName, args}]`.
  if (role === "assistant" && Array.isArray(r.toolCalls)) {
    for (const tc of r.toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const t = tc as Record<string, unknown>;
      const name = typeof t.toolName === "string" ? t.toolName : "";
      if (!name) continue;
      const id =
        typeof t.toolCallId === "string"
          ? t.toolCallId
          : typeof t.id === "string"
            ? t.id
            : undefined;
      parts.push({
        type: "tool_call",
        ...(id ? { id } : {}),
        name,
        arguments: t.args ?? t.arguments ?? t.input,
      });
    }
  }

  const finishReason = asString(r.finish_reason) ?? asString(r.stop_reason) ?? "";
  return { role, content, finish_reason: finishReason, parts };
}

// ---------------------------------------------------------------------------
// Tiny utilities
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function assignInt(out: WeaveAttrs, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    out[key] = Math.trunc(value);
  }
}

function assignFiniteNumber(out: WeaveAttrs, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    out[key] = value;
  }
}
