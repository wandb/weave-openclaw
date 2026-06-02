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
      // Attribute names follow the OTel GenAI semconv as exposed by the Weave SDK
      // (`gen_ai.usage.*`), matching what the chat span already emits.
      const usage = event.usage;
      if (usage) {
        setIfInt(turn, "gen_ai.usage.input_tokens", usage.input);
        setIfInt(turn, "gen_ai.usage.output_tokens", usage.output);
        setIfInt(turn, "gen_ai.usage.total_tokens", usage.total);
        setIfInt(turn, "gen_ai.usage.cache_read.input_tokens", usage.cacheRead);
        setIfInt(turn, "gen_ai.usage.cache_creation.input_tokens", usage.cacheWrite);
      }
      const context = event.context;
      if (context) {
        setIfInt(turn, "weave.context.budget_tokens", context.limit);
        setIfInt(turn, "weave.context.used_tokens", context.used);
      }
    },
  };
}
