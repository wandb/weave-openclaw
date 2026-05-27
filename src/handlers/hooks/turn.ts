// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { HandlerDeps } from "../deps.js";
import type { HookCtx, HookEvent, HookHandler } from "../hook-types.js";

/**
 * Turn-level annotations from hooks: `agent_end` stamps success/error/
 * duration on the active Turn as attributes (the Turn already carries
 * start/end timestamps, so a synthetic timeline event would be redundant
 * and an attribute is what the Agents tab needs to filter and search by);
 * `message_received` records inbound user/assistant traffic as a span event
 * on the active Turn.
 */
export function createTurnHookHandlers(deps: HandlerDeps): {
  agent_end: HookHandler<"agent_end">;
  message_received: HookHandler<"message_received">;
} {
  return {
    agent_end(event: HookEvent<"agent_end">): void {
      if (!event.runId) return;
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      turn.setAttribute("weave.agent.success", event.success);
      if (event.error) turn.setAttribute("weave.agent.error", event.error);
      if (event.durationMs !== undefined && Number.isFinite(event.durationMs)) {
        turn.setAttribute("weave.agent.duration_ms", Math.trunc(event.durationMs));
      }
    },

    message_received(
      event: HookEvent<"message_received">,
      ctx: HookCtx<"message_received">,
    ): void {
      if (!event.runId) return;
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      const attrs: Record<string, string | number | boolean> = {
        "weave.message.from": event.from,
        "weave.message.channel": ctx.channelId,
      };
      const resolved = deps.getResolved();
      if (resolved?.captureContent) {
        attrs["weave.message.content"] = event.content;
      }
      turn.addEvent("message_received", attrs);
    },
  };
}
