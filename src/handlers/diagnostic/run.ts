// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated, startSession, startTurn } from "weave";
import { stableAgentId } from "../../util/agent-id.js";
import { setBoundedMap } from "../../util/bounded-map.js";
import { MAX_ENTRIES } from "../../state/registries.js";
import type { HandlerDeps } from "../deps.js";
import { closeRunChatSpans } from "../llm-state.js";

export function createRunDiagnosticHandlers(deps: HandlerDeps) {
  return {
    /** `run.started`: open the invoke_agent Turn for this runId. */
    onRunStarted(event: any): void {
      const resolved = deps.getResolved();
      if (!resolved) return;
      if (deps.registries.turns.has(event.runId)) return;
      const sessionKey: string | undefined = event.sessionKey;
      const existingSession = sessionKey
        ? deps.registries.sessions.get(sessionKey)
        : undefined;
      const agentName =
        resolved.agentName ?? stableAgentId(resolved.entity, resolved.project, undefined);
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
              setBoundedMap(deps.registries.sessions, sessionKey, s, MAX_ENTRIES);
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
      setBoundedMap(deps.registries.turns, event.runId, turn, MAX_ENTRIES);
    },

    /**
     * `run.completed`: close any chat spans tracked under this run first
     * (their content is keyed by runId/callId in shared state), then close
     * the parent Turn, stamping `weave.outcome`.
     *
     * Outcome -> OTel span status mapping. `aborted` / `cancelled` are user
     * actions, not failures, so they stay OK with the outcome surfaced as
     * an attribute; only genuine failures (`failed` / `errored` / `timeout`)
     * mark the span ERROR. An unknown outcome string is treated as a
     * failure too, so a new upstream value defaults to "loud" rather than
     * silently being filed as success.
     */
    onRunFinalize(event: any): void {
      const runId: string = event.runId;
      closeRunChatSpans(deps, runId);
      const turn = deps.registries.turns.get(runId);
      if (!turn) return;
      const outcome = typeof event.outcome === "string" ? event.outcome : undefined;
      if (outcome) turn.setAttribute("weave.outcome", outcome);
      if (isErrorOutcome(outcome)) {
        turn.end({ error: new Error(outcome) });
      } else {
        turn.end();
      }
      deps.registries.turns.delete(runId);
      deps.costByRun.delete(runId);
      deps.pendingCompactionByRun.delete(runId);
    },

    /** `run.attempt`: stamp the attempt number on the Turn as a span event. */
    onRunAttempt(event: any): void {
      const runId: string | undefined = event.runId;
      if (!runId) return;
      const turn = deps.registries.turns.get(runId);
      if (!turn) return;
      const attrs: Record<string, string | number | boolean> = {};
      if (typeof event.attempt === "number" && Number.isFinite(event.attempt)) {
        attrs["weave.run.attempt"] = Math.trunc(event.attempt);
      }
      if (Object.keys(attrs).length === 0) return;
      turn.addEvent("run_attempt", attrs);
    },
  };
}

/**
 * Treat outcomes as failures only when they explicitly signal one. `aborted`
 * / `cancelled` (user actions or graceful shutdown) stay OK. Unknown outcome
 * strings are treated as failures so a new upstream value defaults to loud.
 */
function isErrorOutcome(outcome: string | undefined): boolean {
  if (!outcome) return false;
  switch (outcome) {
    case "completed":
    case "aborted":
    case "cancelled":
      return false;
    default:
      return true;
  }
}
