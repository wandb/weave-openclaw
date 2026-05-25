// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated, startSession } from "weave";
import { stableAgentId } from "../../util/agent-id.js";
import { setBoundedMap } from "../../util/bounded-map.js";
import { MAX_ENTRIES } from "../../state/registries.js";
import type { HandlerDeps } from "../deps.js";

export function createSessionHookHandlers(deps: HandlerDeps) {
  return {
    session_start(event: any): void {
      const key = event.sessionKey;
      const resolved = deps.getResolved();
      if (!key || !resolved || deps.registries.sessions.has(key)) return;
      const session = runIsolated(() =>
        startSession({
          sessionId: key,
          agentName:
            resolved.agentName ?? stableAgentId(resolved.entity, resolved.project, undefined),
        }),
      );
      setBoundedMap(deps.registries.sessions, key, session, MAX_ENTRIES);
    },

    session_end(event: any): void {
      const key = event.sessionKey;
      if (!key) return;
      deps.registries.sessions.get(key)?.end();
      deps.registries.sessions.delete(key);
    },
  };
}
