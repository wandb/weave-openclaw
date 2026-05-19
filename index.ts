// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  beginModelCall,
  bufferPendingLlmInputForRun,
  captureLlmInput,
  captureLlmOutput,
  captureToolEnd,
  captureToolStart,
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

    const { service, flushChatSpan, getStatus } = createWeaveService({
      pluginConfig: api.pluginConfig,
      hookState,
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
