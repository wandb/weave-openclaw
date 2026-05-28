// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { HandlerDeps } from "../deps.js";
import { setIfInt } from "../util.js";

type ModelUsageEvent = Extract<DiagnosticEventPayload, { type: "model.usage" }>;

export function createUsageDiagnosticHandlers(deps: HandlerDeps) {
  return {
    // runId isn't on the public type but the runtime attaches it for rollup.
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
      // usage is typed required but the runtime sometimes emits cost-only; guard.
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
