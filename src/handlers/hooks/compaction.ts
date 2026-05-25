// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { HandlerDeps } from "../deps.js";

export function createCompactionHookHandlers(deps: HandlerDeps) {
  return {
    before_compaction(event: any, ctx: any): void {
      const runId: string | undefined = ctx?.runId;
      if (!runId) return;
      deps.pendingCompactionByRun.set(runId, {
        itemsBefore: typeof event.messageCount === "number" ? event.messageCount : 0,
      });
    },

    after_compaction(event: any, ctx: any): void {
      const runId: string | undefined = ctx?.runId;
      if (!runId) return;
      const turn = deps.registries.turns.get(runId);
      if (!turn) return;
      const before = deps.pendingCompactionByRun.get(runId);
      deps.pendingCompactionByRun.delete(runId);
      const itemsBefore =
        before?.itemsBefore ??
        (typeof event.messageCount === "number" && typeof event.compactedCount === "number"
          ? event.messageCount + event.compactedCount
          : typeof event.messageCount === "number"
            ? event.messageCount
            : 0);
      const itemsAfter = typeof event.messageCount === "number" ? event.messageCount : 0;
      const tokens = typeof event.tokenCount === "number" ? event.tokenCount : 0;
      turn.addEvent("context_compacted", {
        items_before: itemsBefore,
        items_after: itemsAfter,
        tokens,
      });
    },
  };
}
