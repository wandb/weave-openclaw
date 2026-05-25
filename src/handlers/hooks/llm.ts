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
import { dbg } from "../../util/dbg.js"; // DEBUG[weave-msg-trace]

export function createLlmHookHandlers(deps: HandlerDeps) {
  return {
    model_call_started(event: any): void {
      dbg(
        `model_call_started runId=${event.runId} callId=${event.callId}`,
        deps.instanceId,
      );
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
      dbg(
        `llm_input runId=${event.runId} resolvedCallId=${callId} ` +
          `promptLen=${typeof event.prompt === "string" ? event.prompt.length : "NA"} ` +
          `systemPromptLen=${typeof event.systemPrompt === "string" ? event.systemPrompt.length : "NA"} ` +
          `historyLen=${Array.isArray(event.historyMessages) ? event.historyMessages.length : "NA"}`,
        deps.instanceId,
      );
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
      dbg(
        `llm_output runId=${runId} assistantTextsLen=${texts.length} ` +
          `firstTextLen=${typeof texts[0] === "string" ? texts[0].length : "NA"} ` +
          `usagePresent=${event.usage ? "y" : "n"} ` +
          `callsInRegistry=${deps.registries.calls.size}`,
        deps.instanceId,
      );
      if (!runId) return;
      deps.registries.assistantOutputByRun.set(runId, {
        texts,
        usage: event.usage,
      });
    },
  };
}
