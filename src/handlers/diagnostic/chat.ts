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
    // open the LLM span + track its callId; closeRunChatSpans does the .end().
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

    // record status only; closeRunChatSpans does the .end().
    onChatFinalize(
      event: ChatFinalizeEvent,
      status: "ok" | "error",
      errorType: string | undefined,
    ): void {
      const handle = deps.registries.calls.get(event.callId);
      if (!handle) return;
      handle.status = status;
      handle.errorType = errorType;
    },
  };
}
