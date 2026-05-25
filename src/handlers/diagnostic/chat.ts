// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated } from "weave";
import { setBoundedMap } from "../../util/bounded-map.js";
import { MAX_ENTRIES } from "../../state/registries.js";
import type { HandlerDeps } from "../deps.js";

export function createChatDiagnosticHandlers(deps: HandlerDeps) {
  return {
    /**
     * `model.call.started`: open an LLM handle under the current Turn and
     * track the callId in the per-run chat-span list. Actual `LLM.end()` is
     * deferred to `closeRunChatSpans` (called from `onRunFinalize`) so the
     * run-scoped `llm_output` content can be attached.
     */
    onChatStart(event: any): void {
      if (!deps.getResolved()) return;
      const runId: string | undefined = event.runId;
      const callId: string | undefined = event.callId;
      if (!runId || !callId) return;
      const turn = deps.registries.turns.get(runId);
      if (!turn) return;
      const llm = runIsolated(() =>
        turn.startLLM({
          model: event.model ?? "unknown",
          providerName: event.provider,
        }),
      );
      setBoundedMap(
        deps.registries.calls,
        callId,
        { llm, status: "ok" },
        MAX_ENTRIES,
      );
      const list = deps.registries.chatCallsByRun.get(runId);
      if (list) {
        list.push(callId);
      } else {
        deps.registries.chatCallsByRun.set(runId, [callId]);
      }
    },

    /**
     * `model.call.{completed,error}`: stamp end-time, status, and errorType
     * on the handle. The LLM span is NOT closed here — closing is deferred
     * to `closeRunChatSpans` (run.completed) so the run-level `llm_output`
     * content can be attached. OpenClaw fires `llm_output` once per attempt
     * carrying ALL assistantTexts; closing earlier would emit an empty span.
     */
    onChatFinalize(
      event: any,
      status: "ok" | "error",
      errorType: string | undefined,
    ): void {
      const callId: string | undefined = event.callId;
      const h = callId ? deps.registries.calls.get(callId) : undefined;
      if (!h) return;
      h.status = status;
      h.errorType = errorType;
    },
  };
}
