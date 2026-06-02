// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { HandlerDeps } from "../deps.js";
import type { HookCtx, HookEvent, HookHandler } from "../hook-types.js";

export function createCompactionHookHandlers(deps: HandlerDeps): {
  before_compaction: HookHandler<"before_compaction">;
  after_compaction: HookHandler<"after_compaction">;
} {
  return {
    before_compaction(
      event: HookEvent<"before_compaction">,
      ctx: HookCtx<"before_compaction">,
    ): void {
      const runId = ctx.runId;
      if (!runId) return;
      deps.pendingCompactionByRun.set(runId, { itemsBefore: event.messageCount });
    },

    after_compaction(
      event: HookEvent<"after_compaction">,
      ctx: HookCtx<"after_compaction">,
    ): void {
      const runId = ctx.runId;
      if (!runId) return;

      const turn = deps.registries.turns.get(runId);
      if (!turn) return;

      const before = deps.pendingCompactionByRun.get(runId);
      deps.pendingCompactionByRun.delete(runId);

      // When before_compaction never fired, reconstruct the pre-compaction count
      // as the survivors plus the number compacted away.
      turn.addEvent("context_compacted", {
        "weave.compaction.items_before": before?.itemsBefore ?? event.messageCount + event.compactedCount,
        "weave.compaction.items_after": event.messageCount,
      });
    },
  };
}
