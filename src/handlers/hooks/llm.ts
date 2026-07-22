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
      // Gate at ingestion so disabled content never enters transient state.
      if (!deps.getResolved()?.captureContent) return;
      const capture = {
        prompt: event.prompt,
        historyMessages: event.historyMessages,
      };
      if (event.systemPrompt) {
        deps.hookState.systemPromptByRun.set(event.runId, event.systemPrompt);
      } else {
        deps.hookState.systemPromptByRun.delete(event.runId);
      }
      const callId = resolveCurrentCallId(deps.hookState, event.runId);
      const systemInstructions = event.systemPrompt ? [event.systemPrompt] : [];
      deps.registries.turns.get(event.runId)?.record({ systemInstructions });
      if (callId && event.systemPrompt) {
        // The diagnostic model-call event can precede this hook. LLM's
        // systemInstructions constructor field is immutable, so enrich an
        // already-open span with the same wire shape the SDK emits at end().
        deps.registries.calls.get(callId)?.llm.setAttributes({
          "gen_ai.system_instructions": JSON.stringify([
            { type: "text", content: event.systemPrompt },
          ]),
        });
      }
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
