// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated, startTurn } from "weave";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { HandlerDeps } from "../deps.js";
import { getOrCreateSession } from "../hooks/session.js";
import { closeRunChatSpans } from "../llm-state.js";

type RunStartedEvent = Extract<DiagnosticEventPayload, { type: "run.started" }>;
type RunCompletedEvent = Extract<DiagnosticEventPayload, { type: "run.completed" }>;
type RunAttemptEvent = Extract<DiagnosticEventPayload, { type: "run.attempt" }>;

export function createRunDiagnosticHandlers(deps: HandlerDeps) {
  return {
    onRunStarted(event: RunStartedEvent): void {
      const resolved = deps.getResolved();
      if (!resolved) return;
      if (deps.registries.turns.has(event.runId)) return;
      const agentName = resolved.agentName;
      // Lazy-create, not redundant with session_start: a run can reach us for a
      // live sessionKey whose session_start we never saw (plugin started mid-session).
      const session = getOrCreateSession(deps, event.sessionKey, agentName);
      const turn = runIsolated(() =>
        session
          ? session.startTurn({ agentName, model: event.model })
          : startTurn({ agentName, model: event.model }),
      );
      if (resolved.agentVersion)
        turn.setAttribute("weave.agent.version", resolved.agentVersion);
      if (resolved.agentDescription)
        turn.setAttribute("gen_ai.agent.description", resolved.agentDescription);
      deps.registries.turns.set(event.runId, turn);
      // Index by sessionKey so tool.loop events (which omit runId) reach this Turn.
      if (event.sessionKey) deps.runIdBySession.set(event.sessionKey, event.runId);
    },

    // Only the "error" outcome marks the Turn ERROR; completed and aborted stay OK.
    onRunFinalize(event: RunCompletedEvent): void {
      closeRunChatSpans(deps, event.runId);
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      turn.setAttribute("weave.outcome", event.outcome);
      if (isErrorOutcome(event.outcome)) {
        turn.end({ error: new Error(event.outcome) });
      } else {
        turn.end();
      }
      deps.registries.turns.delete(event.runId);
      deps.costByRun.delete(event.runId);
      deps.pendingCompactionByRun.delete(event.runId);
      if (event.sessionKey) deps.runIdBySession.delete(event.sessionKey);
    },

    onRunAttempt(event: RunAttemptEvent): void {
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      turn.addEvent("run_attempt", { "weave.run.attempt": event.attempt });
    },
  };
}

function isErrorOutcome(outcome: RunCompletedEvent["outcome"]): boolean {
  return outcome === "error";
}
