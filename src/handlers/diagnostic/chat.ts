// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated } from "weave";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { HandlerDeps } from "../deps.js";
import { finalizeChatSpan } from "../llm-state.js";

type ChatStartEvent = Extract<DiagnosticEventPayload, { type: "model.call.started" }>;
type ChatFinalizeEvent = Extract<
  DiagnosticEventPayload,
  { type: "model.call.completed" | "model.call.error" }
>;

export function createChatDiagnosticHandlers(deps: HandlerDeps) {
  return {
    // open the LLM span + track its callId; onChatFinalize ends it at model.call.completed.
    onChatStart(event: ChatStartEvent): void {
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      // llm_input only populates this map when content capture is enabled.
      const systemPrompt = deps.hookState.systemPromptByRun.get(event.runId);
      if (systemPrompt) turn.record({ systemInstructions: [systemPrompt] });
      const llm = runIsolated(() =>
        turn.startLLM({
          model: event.model,
          providerName: event.provider,
          ...(systemPrompt ? { systemInstructions: [systemPrompt] } : {}),
        }),
      );
      // Default ok; a call with no model.call.completed/error before run.completed closes ok.
      deps.registries.calls.set(event.callId, { llm, status: "ok" });
      const list = deps.hookState.chatCallsByRun.get(event.runId);
      if (list) {
        list.push(event.callId);
      } else {
        deps.hookState.chatCallsByRun.set(event.runId, [event.callId]);
      }
    },

    // close the chat span now so its input exports mid-run; run.completed only
    // backstops spans that never reach a model.call.completed/error.
    onChatFinalize(
      event: ChatFinalizeEvent,
      status: "ok" | "error",
      errorType: string | undefined,
    ): void {
      finalizeChatSpan(deps, event.runId, event.callId, status, errorType);
    },
  };
}
