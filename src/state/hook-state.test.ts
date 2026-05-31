// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, expect, test } from "vitest";
import {
  beginModelCall,
  bufferPendingLlmInputForRun,
  createWeaveHookState,
} from "./hook-state.js";

describe("hook-state pending llm_input buffer", () => {
  test("buffers llm_input before model_call_started and promotes it per callId across turns", () => {
    const state = createWeaveHookState();
    bufferPendingLlmInputForRun(state, "r", { prompt: "first", systemPrompt: "sys" });
    beginModelCall(state, "r", "c-1");
    expect(state.llmInputs.get("c-1")?.prompt).toBe("first");
    expect(state.llmInputs.get("c-1")?.systemPrompt).toBe("sys");
    expect(state.pendingLlmInputByRun.get("r")).toBeUndefined();

    // Next turn attributes to its own callId, not the previous one.
    bufferPendingLlmInputForRun(state, "r", { prompt: "second" });
    beginModelCall(state, "r", "c-2");
    expect(state.llmInputs.get("c-2")?.prompt).toBe("second");
  });

  test("no-ops on a missing buffer or empty runId", () => {
    const state = createWeaveHookState();
    beginModelCall(state, "r", "c-1");
    expect(state.llmInputs.get("c-1")).toBeUndefined();
    bufferPendingLlmInputForRun(state, "", { prompt: "x" });
    expect(state.pendingLlmInputByRun.size).toBe(0);
  });
});
