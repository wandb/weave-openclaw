// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { runIsolated } from "weave";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { lookupToolCall } from "../../state/hook-state.js";
import type { HandlerDeps } from "../deps.js";
import { propagateIntegration } from "../integration.js";
import { safeJson } from "../util.js";

type ToolStartEvent = Extract<DiagnosticEventPayload, { type: "tool.execution.started" }>;
type ToolFinalizeEvent = Extract<
  DiagnosticEventPayload,
  { type: "tool.execution.completed" | "tool.execution.error" | "tool.execution.blocked" }
>;
type ToolLoopEvent = Extract<DiagnosticEventPayload, { type: "tool.loop" }>;

export function createToolDiagnosticHandlers(deps: HandlerDeps) {
  return {
    onToolStart(event: ToolStartEvent): void {
      const resolved = deps.getResolved();
      if (!resolved) return;
      if (!event.runId || !event.toolCallId) return;
      const turn = deps.registries.turns.get(event.runId);
      if (!turn) return;
      const captured = lookupToolCall(deps.hookState, event.toolCallId).args;
      const args = resolved.captureContent
        ? safeJson(captured?.params ?? event.paramsSummary)
        : undefined;
      const tool = runIsolated(() =>
        propagateIntegration(
          turn.startTool({
            name: event.toolName ?? captured?.toolName ?? "unknown",
            toolCallId: event.toolCallId,
            args,
          }),
        ),
      );
      deps.registries.tools.set(event.toolCallId, tool);
    },

    onToolFinalize(
      event: ToolFinalizeEvent,
      status: "ok" | "error",
      errorType: string | undefined,
    ): void {
      if (!event.toolCallId) return;
      if (!deps.registries.tools.has(event.toolCallId)) return;
      // The result rides in on after_tool_call, which OpenClaw fires
      // fire-and-forget — usually after this terminal diagnostic. Record the
      // status and let finalizeTool close the span once the result is in (or
      // now, if after_tool_call already won the race).
      deps.pendingToolFinalize.set(event.toolCallId, {
        status,
        errorType,
        runId: event.runId,
      });
      finalizeTool(deps, event.toolCallId);
    },

    onToolLoop(event: ToolLoopEvent): void {
      // tool.loop carries sessionKey, not runId; map back to the run's open Turn.
      const runId = event.sessionKey && deps.runIdBySession.get(event.sessionKey);
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

// Close a tool span once both signals are in: the terminal diagnostic (status,
// held in pendingToolFinalize) and after_tool_call (result, in the hook-state
// buffer). Whichever arrives second triggers the end. `force` closes with
// whatever is available — used by the run.completed backstop for a tool whose
// after_tool_call never fired (e.g. a blocked call).
export function finalizeTool(
  deps: HandlerDeps,
  toolCallId: string,
  opts: { force?: boolean } = {},
): void {
  const tool = deps.registries.tools.get(toolCallId);
  if (!tool) return;
  const pending = deps.pendingToolFinalize.get(toolCallId);
  if (!pending && !opts.force) return; // no terminal status yet
  const captured = lookupToolCall(deps.hookState, toolCallId).result;
  if (!opts.force && captured === undefined) return; // after_tool_call not in yet
  if (deps.getResolved()?.captureContent) {
    const result = safeJson(captured?.result);
    if (result !== undefined) tool.result = result;
  }
  tool.end(
    pending?.status === "error"
      ? { error: new Error(pending.errorType ?? "tool.execution.error") }
      : undefined,
  );
  clearToolCall(deps, toolCallId);
}

// Single owner of per-tool-call teardown: every map keyed by toolCallId is
// dropped here, so adding new tool-call state is one edit, not a scavenger hunt.
function clearToolCall(deps: HandlerDeps, toolCallId: string): void {
  deps.registries.tools.delete(toolCallId);
  deps.pendingToolFinalize.delete(toolCallId);
  deps.hookState.toolCallArgs.delete(toolCallId);
  deps.hookState.toolCallResults.delete(toolCallId);
}

// run.completed backstop: close any tool of this run still waiting on an
// after_tool_call that never arrived, so its span never leaks open.
export function finalizeRunTools(deps: HandlerDeps, runId: string): void {
  for (const [toolCallId, pending] of deps.pendingToolFinalize) {
    if (pending.runId !== runId) continue;
    finalizeTool(deps, toolCallId, { force: true });
    deps.pendingToolFinalize.delete(toolCallId);
  }
}
