// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated } from "weave";
import { setBoundedMap } from "../../util/bounded-map.js";
import { MAX_ENTRIES } from "../../state/registries.js";
import type { HandlerDeps } from "../deps.js";

export function createSubagentHookHandlers(deps: HandlerDeps) {
  return {
    subagent_spawned(event: any, ctx: any): void {
      if (!deps.getResolved()) return;
      const requesterRunId: string | undefined = ctx?.runId;
      const turn = requesterRunId ? deps.registries.turns.get(requesterRunId) : undefined;
      if (!turn) return;
      if (deps.registries.subagents.has(event.runId)) return;
      const sub = runIsolated(() => turn.startSubagent({ name: event.agentId }));
      const evAttrs: Record<string, string | number | boolean> = {
        "weave.agent.id": event.agentId,
        "weave.subagent.mode": event.mode ?? "run",
      };
      if (event.label) evAttrs["weave.agent.description"] = event.label;
      if (event.childSessionKey) evAttrs["gen_ai.conversation.id"] = event.childSessionKey;
      turn.addEvent("subagent_spawned", evAttrs);
      setBoundedMap(deps.registries.subagents, event.runId, sub, MAX_ENTRIES);
    },

    subagent_ended(event: any): void {
      const sub = deps.registries.subagents.get(event.runId);
      if (!sub) return;
      const outcome = typeof event.outcome === "string" ? event.outcome : undefined;
      if (outcome && outcome !== "ok") {
        sub.end({ error: new Error(outcome) });
      } else {
        sub.end();
      }
      deps.registries.subagents.delete(event.runId);
    },
  };
}
