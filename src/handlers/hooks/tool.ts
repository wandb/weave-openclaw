// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { captureToolEnd, captureToolStart } from "../../state/hook-state.js";
import type { HandlerDeps } from "../deps.js";
import { dbg } from "../../util/dbg.js"; // DEBUG[weave-msg-trace]

export function createToolHookHandlers(deps: HandlerDeps) {
  return {
    before_tool_call(event: any): void {
      dbg(
        `before_tool_call toolCallId=${event.toolCallId} toolName=${event.toolName} ` +
          `paramsKeys=${event.params && typeof event.params === "object" ? Object.keys(event.params).join(",") : `NA(${typeof event.params})`}`,
      );
      if (!event.toolCallId) return;
      captureToolStart(deps.hookState, event.toolCallId, {
        toolName: event.toolName,
        params: event.params,
        runId: event.runId,
      });
    },

    after_tool_call(event: any): void {
      dbg(
        `after_tool_call toolCallId=${event.toolCallId} toolName=${event.toolName} ` +
          `resultPresent=${event.result !== undefined ? "y" : "n"} ` +
          `resultType=${typeof event.result}`,
      );
      if (!event.toolCallId) return;
      captureToolEnd(deps.hookState, event.toolCallId, {
        result: event.result,
      });
    },
  };
}
