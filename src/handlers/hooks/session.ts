// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated, startSession, type Session } from "weave";
import type { HandlerDeps } from "../deps.js";
import type { HookEvent, HookHandler } from "../hook-types.js";

// Get-or-create the Session for this key, idempotent so its two callers (the
// session_start hook and onRunStarted) can each be first. Returns undefined
// when there is no key, so the caller opens a root Turn.
export function getOrCreateSession(
  deps: HandlerDeps,
  sessionKey: string | undefined,
  agentName: string,
): Session | undefined {
  if (!sessionKey) return undefined;
  const existing = deps.registries.sessions.get(sessionKey);
  if (existing) return existing;
  const session = runIsolated(() =>
    startSession({ sessionId: sessionKey, agentName }),
  );
  deps.registries.sessions.set(sessionKey, session);
  return session;
}

export function createSessionHookHandlers(deps: HandlerDeps): {
  session_start: HookHandler<"session_start">;
  session_end: HookHandler<"session_end">;
} {
  return {
    session_start(event: HookEvent<"session_start">): void {
      const resolved = deps.getResolved();
      if (!resolved) return;
      getOrCreateSession(deps, event.sessionKey, resolved.agentName);
    },

    session_end(event: HookEvent<"session_end">): void {
      const key = event.sessionKey;
      if (!key) return;
      deps.registries.sessions.get(key)?.end();
      deps.registries.sessions.delete(key);
    },
  };
}
