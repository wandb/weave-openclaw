// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated } from "weave";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { lookupToolCall } from "../../state/hook-state.js";
import { BOUNDED_MAP_CAP, setBoundedMap } from "../../util/bounded-map.js";
import type { HandlerDeps } from "../deps.js";
import { safeJson } from "../util.js";

type ToolStartEvent = Extract<DiagnosticEventPayload, { type: "tool.execution.started" }>;
type ToolFinalizeEvent = Extract<
  DiagnosticEventPayload,
  { type: "tool.execution.completed" | "tool.execution.error" | "tool.execution.blocked" }
>;
type ToolLoopEvent = Extract<DiagnosticEventPayload, { type: "tool.loop" }>;

export function createToolDiagnosticHandlers(deps: HandlerDeps) {
  return {
    /** `tool.execution.started`: open a Tool span under the current Turn. */
    onToolStart(event: ToolStartEvent): void {
      const resolved = deps.getResolved();
      if (!resolved) return;
      if (!event.runId || !event.toolCallId) return;
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      const captured = lookupToolCall(deps.hookState, event.toolCallId).args;
      // `toolInput` is an undocumented field the runtime sometimes attaches
      // alongside `paramsSummary`. Not on the public type; falls back when
      // present so we get richer args than the summary.
      const runtimeToolInput = (event as unknown as { toolInput?: unknown }).toolInput;
      const args = resolved.captureContent
        ? safeJson(captured?.params ?? runtimeToolInput ?? event.paramsSummary)
        : undefined;
      const tool = runIsolated(() =>
        turn.startTool({
          name: event.toolName ?? captured?.toolName ?? "unknown",
          toolCallId: event.toolCallId,
          args,
        }),
      );
      setBoundedMap(deps.registries.tools, event.toolCallId, tool, BOUNDED_MAP_CAP);
    },

    /** `tool.execution.{completed,error,blocked}`: close the Tool span. */
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
        // `toolOutput` mirrors `toolInput`: undocumented runtime fallback.
        const runtimeToolOutput = (event as unknown as { toolOutput?: unknown }).toolOutput;
        const result = safeJson(captured?.result ?? runtimeToolOutput);
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

    /** `tool.loop`: annotate the Turn with a tool-loop span event. */
    onToolLoop(event: ToolLoopEvent): void {
      const runId = (event as unknown as { runId?: string }).runId;
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
