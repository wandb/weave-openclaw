// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated, startSession, startTurn } from "weave";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { BOUNDED_MAP_CAP, setBoundedMap } from "../../util/bounded-map.js";
import type { HandlerDeps } from "../deps.js";
import { closeRunChatSpans } from "../llm-state.js";

type RunStartedEvent = Extract<DiagnosticEventPayload, { type: "run.started" }>;
type RunCompletedEvent = Extract<DiagnosticEventPayload, { type: "run.completed" }>;
type RunAttemptEvent = Extract<DiagnosticEventPayload, { type: "run.attempt" }>;

const DEFAULT_AGENT_NAME = "openclaw-agent";

export function createRunDiagnosticHandlers(deps: HandlerDeps) {
  return {
    /** `run.started`: open the invoke_agent Turn for this runId. */
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
              setBoundedMap(deps.registries.sessions, sessionKey, s, BOUNDED_MAP_CAP);
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
      setBoundedMap(deps.registries.turns, event.runId, turn, BOUNDED_MAP_CAP);
    },

    /**
     * `run.completed`: close any chat spans tracked under this run first
     * (their content is keyed by runId/callId in shared state), then close
     * the parent Turn, stamping `weave.outcome`.
     *
     * Outcome -> OTel span status mapping. `aborted` is a user action, not
     * a failure, so it stays OK with the outcome surfaced as an attribute;
     * `blocked` / `error` mark the span ERROR. Any future upstream outcome
     * value defaults to loud (treated as error) until explicitly classified
     * here.
     */
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
    },

    /** `run.attempt`: stamp the attempt number on the Turn as a span event. */
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

/**
 * Treat outcomes as failures only when they explicitly signal one. `aborted`
 * (user action or graceful shutdown) stays OK. The default branch keeps any
 * unknown / future upstream value loud (treated as error) rather than
 * silently filing it as success.
 */
function isErrorOutcome(outcome: string): boolean {
  return outcome !== "completed" && outcome !== "aborted";
}
