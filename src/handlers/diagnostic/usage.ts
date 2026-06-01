// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { HandlerDeps } from "../deps.js";
import { setIfInt } from "../util.js";

// runId isn't on the published model.usage type but the runtime attaches it for
// per-run rollup; declared as an optional extension (upstream type gap).
type ModelUsageEvent = Extract<DiagnosticEventPayload, { type: "model.usage" }> & { runId?: string };

export function createUsageDiagnosticHandlers(deps: HandlerDeps) {
  return {
    onModelUsage(event: ModelUsageEvent): void {
      const runId = event.runId;
      if (!runId) return;
      const turn = deps.registries.turns.get(runId);
      if (!turn) return;
      if (typeof event.costUsd === "number" && Number.isFinite(event.costUsd)) {
        const total = (deps.costByRun.get(runId) ?? 0) + event.costUsd;
        deps.costByRun.set(runId, total);
        turn.setAttribute("weave.cost.usd", total);
      }
      // usage is typed required but the runtime sometimes emits cost-only; guard.
      // Attribute names follow the Weave Agents semconv (weave.usage.*, no `.total`
      // infix); there is no semconv total-tokens attribute, so total is dropped.
      const usage = event.usage;
      if (usage) {
        setIfInt(turn, "weave.usage.input_tokens", usage.input);
        setIfInt(turn, "weave.usage.output_tokens", usage.output);
        setIfInt(turn, "weave.usage.cache_read.input_tokens", usage.cacheRead);
        setIfInt(turn, "weave.usage.cache_creation.input_tokens", usage.cacheWrite);
      }
      const context = event.context;
      if (context) {
        setIfInt(turn, "weave.context.budget_tokens", context.limit);
        setIfInt(turn, "weave.context.used_tokens", context.used);
      }
    },
  };
}
