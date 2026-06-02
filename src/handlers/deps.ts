// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { ResolvedConfig } from "../config/config.js";
import type { WeaveHookState } from "../state/hook-state.js";
import type { Registries } from "../state/registries.js";
import type { BoundedMap } from "../util/bounded-map.js";

export type HandlerLogger = {
  warn(msg: string): void;
};

// getResolved/getLogger are getters: both are set after start(), not at build.
export type HandlerDeps = {
  registries: Registries;
  hookState: WeaveHookState;
  getResolved: () => ResolvedConfig | undefined;
  getLogger: () => HandlerLogger | undefined;
  costByRun: BoundedMap<string, number>;
  pendingCompactionByRun: BoundedMap<string, { itemsBefore: number }>;
  // tool.loop events carry sessionKey but no runId; this maps the session's
  // active run back to its Turn so loop events can attach.
  runIdBySession: BoundedMap<string, string>;
};
