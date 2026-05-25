// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { HandlerDeps } from "../deps.js";

/**
 * Turn-level annotations from hooks: `agent_end` stamps success/error/
 * duration/final-message on the active Turn as attributes (the Turn already
 * carries start/end timestamps, so a synthetic timeline event would be
 * redundant — and an attribute is what the Agents tab needs to filter and
 * search by); `message_received` records inbound user/assistant traffic
 * as a span event on the active Turn.
 */
export function createTurnHookHandlers(deps: HandlerDeps) {
  return {
    agent_end(event: any): void {
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      if (typeof event.success === "boolean") {
        turn.setAttribute("weave.agent.success", event.success);
      }
      if (event.error) turn.setAttribute("weave.agent.error", String(event.error));
      if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) {
        turn.setAttribute("weave.agent.duration_ms", Math.trunc(event.durationMs));
      }
      const resolved = deps.getResolved();
      if (resolved?.captureContent && event.lastAssistantMessage) {
        turn.setAttribute("weave.agent.final_message", String(event.lastAssistantMessage));
      }
    },

    message_received(event: any): void {
      if (!event.runId) return;
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      const attrs: Record<string, string | number | boolean> = {
        "weave.message.from": String(event.from ?? ""),
      };
      if (event.channel) attrs["weave.message.channel"] = String(event.channel);
      const resolved = deps.getResolved();
      if (resolved?.captureContent && event.content) {
        attrs["weave.message.content"] = String(event.content);
      }
      turn.addEvent("message_received", attrs);
    },
  };
}
