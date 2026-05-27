// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import {
  beginModelCall,
  bufferPendingLlmInputForRun,
  captureLlmInput,
  resolveCurrentCallId,
} from "../../state/hook-state.js";
import type { HandlerDeps } from "../deps.js";
import type { HookEvent, HookHandler } from "../hook-types.js";

export function createLlmHookHandlers(deps: HandlerDeps): {
  model_call_started: HookHandler<"model_call_started">;
  llm_input: HookHandler<"llm_input">;
  llm_output: HookHandler<"llm_output">;
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

    /**
     * `llm_output` fires ONCE per attempt with all assistantTexts and a
     * cumulative usage. Buffer at run scope; `closeRunChatSpans` (called
     * from `onRunFinalize`) attributes each text to its chat span
     * positionally.
     */
    llm_output(event: HookEvent<"llm_output">): void {
      deps.hookState.assistantOutputByRun.set(event.runId, {
        texts: event.assistantTexts,
        usage: event.usage,
      });
    },
  };
}
