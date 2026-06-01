// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { ResolvedConfig } from "../config/config.js";
import type { WeaveHookState } from "../state/hook-state.js";
import type { Registries } from "../state/registries.js";
import type { BoundedMap } from "../util/bounded-map.js";

// getResolved is a getter: set after start(), not at build.
export type HandlerDeps = {
  registries: Registries;
  hookState: WeaveHookState;
  getResolved: () => ResolvedConfig | undefined;
  costByRun: BoundedMap<string, number>;
  pendingCompactionByRun: BoundedMap<string, { itemsBefore: number }>;
};
