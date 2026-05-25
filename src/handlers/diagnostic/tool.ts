// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated } from "weave";
import { lookupToolCall } from "../../state/hook-state.js";
import { setBoundedMap } from "../../util/bounded-map.js";
import { MAX_ENTRIES } from "../../state/registries.js";
import type { HandlerDeps } from "../deps.js";
import { safeJson } from "../util.js";

export function createToolDiagnosticHandlers(deps: HandlerDeps) {
  return {
    /** `tool.execution.started`: open a Tool span under the current Turn. */
    onToolStart(event: any): void {
      const resolved = deps.getResolved();
      if (!resolved) return;
      const runId: string | undefined = event.runId;
      const toolCallId: string | undefined = event.toolCallId;
      if (!runId || !toolCallId) return;
      const turn = deps.registries.turns.get(runId);
      if (!turn) return;
      const captured = lookupToolCall(deps.hookState, toolCallId).args;
      const args = resolved.captureContent
        ? safeJson(captured?.params ?? event.toolInput ?? event.paramsSummary)
        : undefined;
      const tool = runIsolated(() =>
        turn.startTool({
          name: event.toolName ?? captured?.toolName ?? "unknown",
          toolCallId,
          args,
        }),
      );
      setBoundedMap(deps.registries.tools, toolCallId, tool, MAX_ENTRIES);
    },

    /** `tool.execution.{completed,error,blocked}`: close the Tool span. */
    onToolFinalize(
      event: any,
      status: "ok" | "error",
      errorType: string | undefined,
    ): void {
      const toolCallId: string | undefined = event.toolCallId;
      if (!toolCallId) return;
      const tool = deps.registries.tools.get(toolCallId);
      if (!tool) return;
      const resolved = deps.getResolved();
      if (resolved?.captureContent) {
        const captured = lookupToolCall(deps.hookState, toolCallId).result;
        const result = safeJson(captured?.result ?? event.toolOutput);
        if (result !== undefined) tool.result = result;
      }
      tool.end(
        status === "error"
          ? { error: new Error(errorType ?? "tool.execution.error") }
          : undefined,
      );
      deps.registries.tools.delete(toolCallId);
      deps.hookState.toolCallArgs.delete(toolCallId);
      deps.hookState.toolCallResults.delete(toolCallId);
    },

    /** `tool.loop`: annotate the Turn with a tool-loop span event. */
    onToolLoop(event: any): void {
      const runId: string | undefined = event.runId;
      if (!runId) return;
      const turn = deps.registries.turns.get(runId);
      if (!turn) return;
      const attrs: Record<string, string | number | boolean> = {};
      if (typeof event.toolName === "string") attrs["gen_ai.tool.name"] = event.toolName;
      if (typeof event.level === "string") attrs["weave.loop.level"] = event.level;
      if (typeof event.action === "string") attrs["weave.loop.action"] = event.action;
      if (typeof event.count === "number" && Number.isFinite(event.count) && event.count >= 0) {
        attrs["weave.loop.count"] = Math.trunc(event.count);
      }
      if (typeof event.message === "string") attrs["weave.loop.message"] = event.message;
      if (typeof event.detector === "string") attrs["weave.loop.detector"] = event.detector;
      turn.addEvent("tool.loop", attrs);
    },
  };
}
