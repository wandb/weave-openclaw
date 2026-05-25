// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { HandlerDeps } from "../deps.js";

/**
 * Turn-level annotations from hooks: `agent_end` stamps success/error/duration
 * on the Turn and emits an inline `agent_end_summary` event for timeline
 * views; `message_received` records inbound user/assistant traffic as a span
 * event on the active Turn.
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
      const evAttrs: Record<string, string | number | boolean> = {};
      if (typeof event.success === "boolean") evAttrs["weave.agent.success"] = event.success;
      if (event.error) evAttrs["weave.agent.error"] = String(event.error);
      if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) {
        evAttrs["weave.agent.duration_ms"] = Math.trunc(event.durationMs);
      }
      const resolved = deps.getResolved();
      if (resolved?.captureContent && event.lastAssistantMessage) {
        evAttrs["weave.agent.final_message"] = String(event.lastAssistantMessage);
      }
      turn.addEvent("agent_end_summary", evAttrs);
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
