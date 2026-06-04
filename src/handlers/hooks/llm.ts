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
import type { HookCtx, HookEvent, HookHandler, LlmUsage } from "../hook-types.js";

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

    // The assistant message fires here just before its model.call.completed, so
    // capture this call's output now; onChatFinalize records it on the chat span
    // as it closes (mid-run). The hook carries no callId, so correlate to the
    // in-flight call via sessionKey -> runId -> currentCallByRun.
    before_message_write(
      event: HookEvent<"before_message_write">,
      ctx: HookCtx<"before_message_write">,
    ): void {
      // event.message is the external AgentMessage union (from pi-agent-core, a
      // transitive dep we don't import); read the few fields we need structurally.
      const message = event.message as {
        role?: string;
        content?: unknown;
        usage?: LlmUsage;
      };
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

// Pull the assistant's text out of an AgentMessage's content (a string, or an
// array of { type: "text", text } / { type: "toolCall", ... } blocks). Tool calls
// surface as their own execute_tool spans, so only the text lands on the chat span.
function extractAssistantText(content: unknown): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const blocks = content as Array<{ type?: string; text?: string }>;
  const text = blocks
    .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  return text || undefined;
}
