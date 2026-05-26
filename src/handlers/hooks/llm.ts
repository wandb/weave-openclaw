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

export function createLlmHookHandlers(deps: HandlerDeps) {
  return {
    model_call_started(event: any): void {
      if (event.runId && event.callId) {
        beginModelCall(deps.hookState, event.runId, event.callId);
      }
    },

    llm_input(event: any): void {
      const capture = {
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        historyMessages: event.historyMessages,
      };
      const callId = event.runId
        ? resolveCurrentCallId(deps.hookState, event.runId)
        : undefined;
      if (callId) {
        captureLlmInput(deps.hookState, callId, capture);
      } else if (event.runId) {
        bufferPendingLlmInputForRun(deps.hookState, event.runId, capture);
      }
    },

    /**
     * `llm_output` fires ONCE per attempt with all assistantTexts and a
     * cumulative usage. Buffer at run scope; `closeRunChatSpans` (called
     * from `onRunFinalize`) attributes each text to its chat span
     * positionally.
     */
    llm_output(event: any): void {
      const runId: string | undefined = event.runId;
      const texts = Array.isArray(event.assistantTexts) ? event.assistantTexts : [];
      if (!runId) return;
      deps.hookState.assistantOutputByRun.set(runId, {
        texts,
        usage: event.usage,
      });
    },
  };
}
