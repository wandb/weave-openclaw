// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated } from "weave";
import type { HandlerDeps } from "../deps.js";
import type { HookCtx, HookEvent, HookHandler } from "../hook-types.js";

export function createSubagentHookHandlers(deps: HandlerDeps): {
  subagent_spawned: HookHandler<"subagent_spawned">;
  subagent_ended: HookHandler<"subagent_ended">;
} {
  return {
    subagent_spawned(
      event: HookEvent<"subagent_spawned">,
      ctx: HookCtx<"subagent_spawned">,
    ): void {
      if (!deps.getResolved()) return;
      const requesterRunId = ctx.runId;
      const turn = requesterRunId ? deps.registries.turns.get(requesterRunId) : undefined;
      if (!turn) return;
      if (deps.registries.subagents.has(event.runId)) return;
      const sub = runIsolated(() => turn.startSubagent({ name: event.agentId }));
      const evAttrs: Record<string, string | number | boolean> = {
        "weave.agent.id": event.agentId,
        "weave.subagent.mode": event.mode,
      };
      if (event.label) evAttrs["weave.agent.description"] = event.label;
      if (event.childSessionKey) evAttrs["gen_ai.conversation.id"] = event.childSessionKey;
      turn.addEvent("subagent_spawned", evAttrs);
      deps.registries.subagents.set(event.runId, sub);
    },

    subagent_ended(event: HookEvent<"subagent_ended">): void {
      if (!event.runId) return;
      const sub = deps.registries.subagents.get(event.runId);
      if (!sub) return;
      if (event.outcome && event.outcome !== "ok") {
        sub.end({ error: new Error(event.outcome) });
      } else {
        sub.end();
      }
      deps.registries.subagents.delete(event.runId);
    },
  };
}
