// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated } from "weave";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { HandlerDeps } from "../deps.js";

type ChatStartEvent = Extract<DiagnosticEventPayload, { type: "model.call.started" }>;
type ChatFinalizeEvent = Extract<
  DiagnosticEventPayload,
  { type: "model.call.completed" | "model.call.error" }
>;

export function createChatDiagnosticHandlers(deps: HandlerDeps) {
  return {
    /**
     * `model.call.started`: open an LLM handle under the current Turn and
     * track the callId in the per-run chat-span list. Actual `LLM.end()` is
     * deferred to `closeRunChatSpans` (called from `onRunFinalize`) so the
     * run-scoped `llm_output` content can be attached.
     */
    onChatStart(event: ChatStartEvent): void {
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      const llm = runIsolated(() =>
        turn.startLLM({
          model: event.model,
          providerName: event.provider,
        }),
      );
      deps.registries.calls.set(event.callId, { llm, status: "ok" });
      const list = deps.hookState.chatCallsByRun.get(event.runId);
      if (list) {
        list.push(event.callId);
      } else {
        deps.hookState.chatCallsByRun.set(event.runId, [event.callId]);
      }
    },

    /**
     * `model.call.{completed,error}`: stamp status and errorType on the
     * handle. The LLM span is NOT closed here — closing is deferred to
     * `closeRunChatSpans` (run.completed) so the run-level `llm_output`
     * content can be attached. OpenClaw fires `llm_output` once per attempt
     * carrying ALL assistantTexts; closing earlier would emit an empty span.
     */
    onChatFinalize(
      event: ChatFinalizeEvent,
      status: "ok" | "error",
      errorType: string | undefined,
    ): void {
      const h = deps.registries.calls.get(event.callId);
      if (!h) return;
      h.status = status;
      h.errorType = errorType;
    },
  };
}
