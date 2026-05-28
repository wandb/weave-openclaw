// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { HandlerDeps } from "../deps.js";
import { setIfInt } from "../util.js";

type ModelUsageEvent = Extract<DiagnosticEventPayload, { type: "model.usage" }>;

export function createUsageDiagnosticHandlers(deps: HandlerDeps) {
  return {
    /**
     * `model.usage`: cumulative cost + usage totals stamped on the Turn.
     * Cost is accumulated per-run (event-level deltas summed across calls).
     *
     * `runId` is not on the public DiagnosticUsageEvent type but the runtime
     * attaches it for run-scoped rollup. Without it we can't route to a Turn.
     */
    onModelUsage(event: ModelUsageEvent): void {
      const runId = (event as unknown as { runId?: string }).runId;
      if (!runId) return;
      const turn = deps.registries.turns.get(runId);
      if (!turn) return;
      if (Number.isFinite(event.costUsd)) {
        const total = (deps.costByRun.get(runId) ?? 0) + event.costUsd!;
        deps.costByRun.set(runId, total);
        turn.setAttribute("weave.cost.usd", total);
      }
      // `usage` is declared required by the type but the runtime sometimes
      // emits the cost-only shape, so guard rather than crash.
      const usage = event.usage;
      if (usage) {
        setIfInt(turn, "weave.usage.total.input_tokens", usage.input);
        setIfInt(turn, "weave.usage.total.output_tokens", usage.output);
        setIfInt(turn, "weave.usage.total.cache_read.input_tokens", usage.cacheRead);
        setIfInt(turn, "weave.usage.total.cache_creation.input_tokens", usage.cacheWrite);
        setIfInt(turn, "weave.usage.total.tokens", usage.total);
      }
      const context = event.context;
      if (context) {
        setIfInt(turn, "weave.context.budget_tokens", context.limit);
        setIfInt(turn, "weave.context.used_tokens", context.used);
      }
    },
  };
}
