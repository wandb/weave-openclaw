// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  beginModelCall,
  bufferPendingLlmInputForRun,
  captureCompactionStart,
  captureLlmInput,
  captureLlmOutput,
  captureToolEnd,
  captureToolStart,
  consumeCompaction,
  getSharedWeaveHookState,
  resolveCurrentCallId,
} from "./src/hook-state.js";
import { checkSdkCompat } from "./src/sdk-compat.js";
import { createWeaveService } from "./src/service.js";
import { formatWeaveStatus } from "./src/status-format.js";

export default definePluginEntry({
  id: "weave",
  name: "W&B Weave",
  description:
    "Emit OpenClaw agent diagnostic events as OpenTelemetry spans to W&B Weave's Agents OTel endpoint (weave.* namespace, /agents/otel/v1/traces).",
  register(api) {
    // Preflight: ensure the host SDK exposes the surface we need. Older
    // OpenClaw versions silently produce `undefined is not a function` deep
    // inside hook subscription; this catches the incompatibility upfront.
    const compat = checkSdkCompat(api);
    if (!compat.ok) {
      // No ctx.logger yet at register time; use console.error which the
      // gateway captures with the [weave] prefix for identification.
      // eslint-disable-next-line no-console
      console.error(`[weave] ${compat.message}`);
      return;
    }

    // Hook subscriptions populate state that the service reads when finalizing
    // spans. The diagnostic event stream alone doesn't carry prompt content,
    // assistant text, token usage, or tool arguments/results — only hook
    // events do, so we capture them here.
    const hookState = getSharedWeaveHookState();

    // model_call_started carries callId; model_call_ended cleans up. We track
    // currentCallByRun so the llm_input / llm_output hooks (which DON'T carry
    // callId) can stamp their captures under the correct callId-keyed bucket.
    api.on("model_call_started", (event) => {
      if (event.runId && event.callId) {
        beginModelCall(hookState, event.runId, event.callId);
      }
    });

    api.on("llm_input", (event) => {
      // The OpenClaw runtime fires `llm_input` BEFORE `model_call_started`,
      // so the callId is not yet registered when this handler runs. Buffer
      // the input under runId; `beginModelCall` will promote it to the
      // callId-keyed bucket when `model_call_started` arrives next.
      const capture = {
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        historyMessages: event.historyMessages,
      };
      const callId = resolveCurrentCallId(hookState, event.runId);
      if (callId) {
        captureLlmInput(hookState, callId, capture);
        return;
      }
      if (event.runId) {
        bufferPendingLlmInputForRun(hookState, event.runId, capture);
      }
    });

    api.on("llm_output", (event) => {
      const callId = resolveCurrentCallId(hookState, event.runId);
      if (!callId) return;
      captureLlmOutput(hookState, callId, {
        assistantTexts: event.assistantTexts,
        lastAssistant: event.lastAssistant,
        usage: event.usage,
      });
      // OpenClaw emits `model.call.completed` (async-queued diagnostic event)
      // BEFORE the agent loop fires this hook. So when our chat-span finalize
      // handler saw model.call.completed, hookState.llmOutputs[callId] was
      // still empty. The service stashed the close in `pendingChatCloseByCallId`
      // instead of finalizing. Now that we've captured assistantTexts /
      // lastAssistant / usage above, trigger the real close — `flushChatSpan`
      // re-runs the mapper with the populated hookState and stamps content
      // attrs on the chat span before ending it.
      flushChatSpan(callId);
    });

    api.on("before_tool_call", (event) => {
      if (event.toolCallId) {
        captureToolStart(hookState, event.toolCallId, {
          toolName: event.toolName,
          params: event.params,
          runId: event.runId,
        });
      }
    });

    api.on("after_tool_call", (event) => {
      if (event.toolCallId) {
        captureToolEnd(hookState, event.toolCallId, {
          result: event.result,
        });
      }
    });

    const {
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
    } = createWeaveService({
      pluginConfig: api.pluginConfig,
      hookState,
    });

    // Subagent lifecycle: emit a child invoke_agent span for each spawned
    // subagent, parented under the requester's invoke_agent so multi-agent
    // workflows render hierarchically in Weave's Agents tab. The subagent's
    // own model/tool spans live in a separate trace (its own harness emits
    // them); this span brackets the requester's view of the subagent.
    api.on("subagent_spawned", (event, ctx) => {
      if (!event.runId) return;
      startSubagentSpan({
        startTimeMs: Date.now(),
        requesterRunId: ctx?.runId,
        subagentRunId: event.runId,
        agentId: event.agentId,
        label: event.label,
        childSessionKey: event.childSessionKey,
        mode: event.mode,
      });
    });

    api.on("subagent_ended", (event) => {
      if (!event.runId) return;
      endSubagentSpan({
        endTimeMs: event.endedAt ?? Date.now(),
        subagentRunId: event.runId,
        outcome: event.outcome,
        error: event.error,
      });
    });

    // agent_end fires when a harness run finalizes its agent state. Captures
    // the final transcript / success / error as a span event on invoke_agent
    // so runs that ended without a successful model call (no llm_output)
    // still render meaningfully in Weave's chat view.
    api.on("agent_end", (event) => {
      if (!event.runId) return;
      const ev = event as unknown as Record<string, unknown>;
      const lastAssistant =
        typeof ev.lastAssistantMessage === "string" ? ev.lastAssistantMessage : undefined;
      emitAgentEndSummary({
        runId: event.runId,
        success: event.success,
        error: event.error,
        durationMs: event.durationMs,
        lastAssistantMessage: lastAssistant,
      });
    });

    // Inbound boundary: capture what the user actually sent that triggered
    // the run. Span event on invoke_agent (looked up by runId or sessionKey).
    // Without this, the trace starts at harness.run.started and the operator
    // can't see the trigger inline in Weave's chat view.
    api.on("message_received", (event) => {
      const ev = event as unknown as Record<string, unknown>;
      const channel = typeof ev.channel === "string" ? ev.channel : undefined;
      emitMessageReceived({
        runId: event.runId,
        sessionKey: event.sessionKey,
        from: event.from,
        channel,
        content: event.content,
      });
    });

    // Session lifecycle events. session_start typically fires before the
    // first run of the session is born — the service buffers it and stamps
    // when the matching invoke_agent starts. session_end is best-effort
    // (stamped only if a run is still active for that sessionKey).
    api.on("session_start", (event) => {
      if (!event.sessionKey) return;
      emitSessionStart({
        sessionKey: event.sessionKey,
        resumedFrom: event.resumedFrom,
      });
    });

    api.on("session_end", (event) => {
      if (!event.sessionKey) return;
      emitSessionEnd({
        sessionKey: event.sessionKey,
        reason: event.reason,
        durationMs: event.durationMs,
        messageCount: event.messageCount,
      });
    });

    // Compaction has no matching diagnostic event, so we emit a `context_compacted`
    // span directly from the hook pair. Parent under the active invoke_agent
    // via ctx.trace.parentSpanId/spanId — whichever maps to the harness's
    // currently-open span.
    api.on("before_compaction", (event, ctx) => {
      if (!ctx?.runId) return;
      captureCompactionStart(hookState, ctx.runId, {
        startTimeMs: Date.now(),
        messageCount: event.messageCount,
        tokenCount: event.tokenCount,
        compactingCount: event.compactingCount,
        traceId: ctx.trace?.traceId,
        parentSpanId: ctx.trace?.spanId,
        sessionKey: ctx.sessionKey,
      });
    });

    api.on("after_compaction", (event, ctx) => {
      const runId = ctx?.runId;
      if (!runId) return;
      const start = consumeCompaction(hookState, runId);
      const startTimeMs = start?.startTimeMs ?? Date.now() - 1;
      const itemsBefore = start?.messageCount ?? event.messageCount + event.compactedCount;
      const itemsAfter = event.messageCount;
      emitCompactionSpan({
        startTimeMs,
        endTimeMs: Date.now(),
        itemsBefore,
        itemsAfter,
        tokenCount: event.tokenCount,
        conversationId: start?.sessionKey ?? ctx?.sessionKey ?? runId,
        parentOpenclawSpanId: start?.parentSpanId ?? ctx?.trace?.spanId,
      });
    });

    api.registerService(service);

    // Operator-facing "did it work?" command. Renders the live snapshot from
    // getStatus() — endpoint, project, auth source, export counters, and a
    // dashboard link. Surfaces lifecycle (disabled / config-error / running /
    // stopped) so a misconfiguration is visible in chat without grepping the
    // gateway log for `weave: exporting to ...`.
    api.registerCommand({
      name: "weave",
      description: "Show W&B Weave plugin status (endpoint, export counters, last error).",
      acceptsArgs: true,
      handler: (ctx) => {
        const first = (ctx.args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        if (first === "" || first === "status") {
          return { text: formatWeaveStatus(getStatus()) };
        }
        if (first === "help") {
          return {
            text: [
              "Usage: /weave [status|help]",
              "  status   show plugin lifecycle, endpoint, and export counters (default)",
              "  help     show this message",
            ].join("\n"),
          };
        }
        return {
          text: `Unknown /weave subcommand: \`${first}\`. Try \`/weave status\` or \`/weave help\`.`,
        };
      },
    });
  },
});
