// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated, startSession } from "weave";
import type { HandlerDeps } from "../deps.js";
import type { HookEvent, HookHandler } from "../hook-types.js";

const DEFAULT_AGENT_NAME = "openclaw-agent";

export function createSessionHookHandlers(deps: HandlerDeps): {
  session_start: HookHandler<"session_start">;
  session_end: HookHandler<"session_end">;
} {
  return {
    session_start(event: HookEvent<"session_start">): void {
      const key = event.sessionKey;
      const resolved = deps.getResolved();
      if (!key || !resolved || deps.registries.sessions.has(key)) return;
      const session = runIsolated(() =>
        startSession({
          sessionId: key,
          agentName: resolved.agentName ?? DEFAULT_AGENT_NAME,
        }),
      );
      deps.registries.sessions.set(key, session);
    },

    session_end(event: HookEvent<"session_end">): void {
      const key = event.sessionKey;
      if (!key) return;
      deps.registries.sessions.get(key)?.end();
      deps.registries.sessions.delete(key);
    },
  };
}
