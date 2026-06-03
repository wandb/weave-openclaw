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
  // A tool span needs two signals to close with full content: the terminal
  // diagnostic (status) and after_tool_call (result). OpenClaw runs
  // after_tool_call fire-and-forget, so it usually lands after the terminal
  // diagnostic. This holds the terminal status until the result arrives;
  // run.completed force-closes any entry whose after_tool_call never fired.
  pendingToolFinalize: BoundedMap<
    string,
    { status: "ok" | "error"; errorType?: string; runId?: string }
  >;
};
