// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { ResolvedConfig } from "../config/config.js";
import type { WeaveHookState } from "../state/hook-state.js";
import type { Registries } from "../state/registries.js";

/**
 * Shared dependencies passed to every handler factory. `getResolved` is a
 * getter (not a value) because the config is assigned after `start()` runs;
 * handlers are constructed once at plugin-creation time but must observe the
 * latest value.
 */
export type HandlerDeps = {
  registries: Registries;
  hookState: WeaveHookState;
  getResolved: () => ResolvedConfig | undefined;
  /** Cumulative cost per runId. Owned here so onModelUsage and onRunFinalize share it. */
  costByRun: Map<string, number>;
  /** Compaction state captured by before_compaction, consumed by after_compaction. */
  pendingCompactionByRun: Map<string, { itemsBefore: number }>;
};
