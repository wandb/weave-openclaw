// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import {
  beginModelCall,
  bufferPendingLlmInputForRun,
  captureAssistantOutput,
  captureLlmInput,
  resolveCurrentCallId,
} from "../../state/hook-state.js";
import type { HandlerDeps } from "../deps.js";
import type { HookCtx, HookEvent, HookHandler } from "../hook-types.js";

export function createLlmHookHandlers(deps: HandlerDeps): {
  model_call_started: HookHandler<"model_call_started">;
  llm_input: HookHandler<"llm_input">;
  before_message_write: HookHandler<"before_message_write">;
} {
  return {
    model_call_started(event: HookEvent<"model_call_started">): void {
      beginModelCall(deps.hookState, event.runId, event.callId);
    },

    llm_input(event: HookEvent<"llm_input">): void {
      const capture = {
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        historyMessages: event.historyMessages,
      };
      const callId = resolveCurrentCallId(deps.hookState, event.runId);
      if (callId) {
        captureLlmInput(deps.hookState, callId, capture);
      } else {
        bufferPendingLlmInputForRun(deps.hookState, event.runId, capture);
      }
    },

    // Assistant message fires just before this call's model.call.completed; capture
    // its output now. No callId on the hook, so correlate via sessionKey -> runId ->
    // currentCallByRun.
    before_message_write(
      event: HookEvent<"before_message_write">,
      ctx: HookCtx<"before_message_write">,
    ): void {
      const { message } = event;
      if (message.role !== "assistant") return;
      const sessionKey = ctx.sessionKey ?? event.sessionKey;
      const runId = sessionKey ? deps.runIdBySession.get(sessionKey) : undefined;
      const callId = runId ? resolveCurrentCallId(deps.hookState, runId) : undefined;
      if (!callId) return;
      captureAssistantOutput(deps.hookState, callId, {
        text: extractAssistantText(message.content),
        usage: message.usage,
      });
    },
  };
}

type AssistantMessage = Extract<
  HookEvent<"before_message_write">["message"],
  { role: "assistant" }
>;
type TextContent = Extract<AssistantMessage["content"][number], { type: "text" }>;

// Assistant text from the message content blocks. Tool calls get their own
// execute_tool spans, so only text lands on the chat span.
function extractAssistantText(content: AssistantMessage["content"]): string | undefined {
  const text = content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");
  return text || undefined;
}
