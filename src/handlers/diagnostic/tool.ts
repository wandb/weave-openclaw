// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated } from "weave";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { lookupToolCall } from "../../state/hook-state.js";
import type { HandlerDeps } from "../deps.js";
import { safeJson } from "../util.js";

// `toolInput`/`toolOutput`/`runId` are emitted at runtime on these events but the
// published DiagnosticEventPayload doesn't declare them yet (upstream type gap);
// declared here as optional extensions so we read them typed instead of casting.
type ToolStartEvent = Extract<DiagnosticEventPayload, { type: "tool.execution.started" }> & {
  toolInput?: unknown;
};
type ToolFinalizeEvent = Extract<
  DiagnosticEventPayload,
  { type: "tool.execution.completed" | "tool.execution.error" | "tool.execution.blocked" }
> & { toolOutput?: unknown };
type ToolLoopEvent = Extract<DiagnosticEventPayload, { type: "tool.loop" }> & { runId?: string };

export function createToolDiagnosticHandlers(deps: HandlerDeps) {
  return {
    onToolStart(event: ToolStartEvent): void {
      const resolved = deps.getResolved();
      if (!resolved) return;
      if (!event.runId || !event.toolCallId) return;
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      const captured = lookupToolCall(deps.hookState, event.toolCallId).args;
      // toolInput is richer than paramsSummary when present.
      const args = resolved.captureContent
        ? safeJson(captured?.params ?? event.toolInput ?? event.paramsSummary)
        : undefined;
      const tool = runIsolated(() =>
        turn.startTool({
          name: event.toolName ?? captured?.toolName ?? "unknown",
          toolCallId: event.toolCallId,
          args,
        }),
      );
      deps.registries.tools.set(event.toolCallId, tool);
    },

    onToolFinalize(
      event: ToolFinalizeEvent,
      status: "ok" | "error",
      errorType: string | undefined,
    ): void {
      if (!event.toolCallId) return;
      const tool = deps.registries.tools.get(event.toolCallId);
      if (!tool) return;
      const resolved = deps.getResolved();
      if (resolved?.captureContent) {
        const captured = lookupToolCall(deps.hookState, event.toolCallId).result;
        const result = safeJson(captured?.result ?? event.toolOutput);
        if (result !== undefined) tool.result = result;
      }
      tool.end(
        status === "error"
          ? { error: new Error(errorType ?? "tool.execution.error") }
          : undefined,
      );
      deps.registries.tools.delete(event.toolCallId);
      deps.hookState.toolCallArgs.delete(event.toolCallId);
      deps.hookState.toolCallResults.delete(event.toolCallId);
    },

    onToolLoop(event: ToolLoopEvent): void {
      const runId = event.runId;
      if (!runId) return;
      const turn = deps.registries.turns.get(runId);
      if (!turn) return;
      const attrs: Record<string, string | number | boolean> = {
        "gen_ai.tool.name": event.toolName,
        "weave.loop.level": event.level,
        "weave.loop.action": event.action,
        "weave.loop.message": event.message,
        "weave.loop.detector": event.detector,
      };
      if (Number.isFinite(event.count) && event.count >= 0) {
        attrs["weave.loop.count"] = Math.trunc(event.count);
      }
      turn.addEvent("tool.loop", attrs);
    },
  };
}
