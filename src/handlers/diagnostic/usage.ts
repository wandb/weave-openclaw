// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { HandlerDeps } from "../deps.js";
import { setIfInt } from "../util.js";

export function createUsageDiagnosticHandlers(deps: HandlerDeps) {
  return {
    /**
     * `model.usage`: cumulative cost + usage totals stamped on the Turn.
     * Cost is accumulated per-run (event-level deltas summed across calls).
     */
    onModelUsage(event: any): void {
      const runId: string | undefined = event.runId;
      if (!runId) return;
      const turn = deps.registries.turns.get(runId);
      if (!turn) return;
      if (typeof event.costUsd === "number" && Number.isFinite(event.costUsd)) {
        const total = (deps.costByRun.get(runId) ?? 0) + event.costUsd;
        deps.costByRun.set(runId, total);
        turn.setAttribute("weave.cost.usd", total);
      }
      const u = event.usage;
      if (u && typeof u === "object") {
        setIfInt(turn, "weave.usage.total.input_tokens", u.input);
        setIfInt(turn, "weave.usage.total.output_tokens", u.output);
        setIfInt(turn, "weave.usage.total.cache_read.input_tokens", u.cacheRead);
        setIfInt(turn, "weave.usage.total.cache_creation.input_tokens", u.cacheWrite);
        setIfInt(turn, "weave.usage.total.tokens", u.total);
      }
      const c = event.context;
      if (c && typeof c === "object") {
        setIfInt(turn, "weave.context.budget_tokens", c.limit);
        setIfInt(turn, "weave.context.used_tokens", c.used);
      }
    },
  };
}
