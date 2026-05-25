// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { captureToolEnd, captureToolStart } from "../../state/hook-state.js";
import type { HandlerDeps } from "../deps.js";

export function createToolHookHandlers(deps: HandlerDeps) {
  return {
    before_tool_call(event: any): void {
      if (!event.toolCallId) return;
      captureToolStart(deps.hookState, event.toolCallId, {
        toolName: event.toolName,
        params: event.params,
        runId: event.runId,
      });
    },

    after_tool_call(event: any): void {
      if (!event.toolCallId) return;
      captureToolEnd(deps.hookState, event.toolCallId, {
        result: event.result,
      });
    },
  };
}
