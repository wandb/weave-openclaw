// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated, startSession, startTurn } from "weave";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { HandlerDeps } from "../deps.js";

type RunStartedEvent = Extract<DiagnosticEventPayload, { type: "run.started" }>;
type RunCompletedEvent = Extract<DiagnosticEventPayload, { type: "run.completed" }>;
type RunAttemptEvent = Extract<DiagnosticEventPayload, { type: "run.attempt" }>;

const DEFAULT_AGENT_NAME = "openclaw-agent";

export function createRunDiagnosticHandlers(deps: HandlerDeps) {
  return {
    onRunStarted(event: RunStartedEvent): void {
      const resolved = deps.getResolved();
      if (!resolved) return;
      if (deps.registries.turns.has(event.runId)) return;
      const sessionKey = event.sessionKey;
      const existingSession = sessionKey
        ? deps.registries.sessions.get(sessionKey)
        : undefined;
      const agentName = resolved.agentName ?? DEFAULT_AGENT_NAME;
      const session =
        existingSession ??
        (sessionKey
          ? (() => {
              const s = runIsolated(() =>
                startSession({
                  sessionId: sessionKey,
                  agentName,
                }),
              );
              deps.registries.sessions.set(sessionKey, s);
              return s;
            })()
          : undefined);
      const turn = runIsolated(() =>
        session
          ? session.startTurn({ agentName, model: event.model })
          : startTurn({ agentName, model: event.model }),
      );
      if (resolved.agentVersion)
        turn.setAttribute("weave.agent.version", resolved.agentVersion);
      if (resolved.agentDescription)
        turn.setAttribute("weave.agent.description", resolved.agentDescription);
      deps.registries.turns.set(event.runId, turn);
    },

    // aborted stays OK; other non-completed outcomes mark the Turn ERROR.
    onRunFinalize(event: RunCompletedEvent): void {
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
    },

    onRunAttempt(event: RunAttemptEvent): void {
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      if (!Number.isFinite(event.attempt)) return;
      turn.addEvent("run_attempt", {
        "weave.run.attempt": Math.trunc(event.attempt),
      });
    },
  };
}

function isErrorOutcome(outcome: string): boolean {
  return outcome !== "completed" && outcome !== "aborted";
}
