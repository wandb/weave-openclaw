// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { captureToolEnd, captureToolStart } from "../../state/hook-state.js";
import { finalizeTool } from "../diagnostic/tool.js";
import type { HandlerDeps } from "../deps.js";
import type { HookEvent, HookHandler } from "../hook-types.js";

export function createToolHookHandlers(deps: HandlerDeps): {
  before_tool_call: HookHandler<"before_tool_call">;
  after_tool_call: HookHandler<"after_tool_call">;
} {
  return {
    before_tool_call(event: HookEvent<"before_tool_call">): void {
      if (!event.toolCallId) return;
      captureToolStart(deps.hookState, event.toolCallId, {
        toolName: event.toolName,
        params: event.params,
        runId: event.runId,
      });
    },

    after_tool_call(event: HookEvent<"after_tool_call">): void {
      if (!event.toolCallId) return;
      captureToolEnd(deps.hookState, event.toolCallId, {
        result: event.result,
      });
      // Result is now buffered; close the span if the terminal diagnostic
      // already recorded the status (the usual order).
      finalizeTool(deps, event.toolCallId);
    },
  };
}
