// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, expect, test } from "vitest";
import {
  beginModelCall,
  bufferPendingLlmInputForRun,
  captureLlmOutput,
  createWeaveHookState,
  lookupLlm,
} from "./hook-state.js";

describe("hook-state pending llm_input buffer", () => {
  test("llm_input that fires before model_call_started is preserved and promoted on beginModelCall", () => {
    // Real-runtime hook order: `llm_input` fires BEFORE `model_call_started`
    // for the same model call. Without a buffer, the plugin loses the prompt
    // because `resolveCurrentCallId` returns undefined when called from
    // llm_input.
    const state = createWeaveHookState();
    const runId = "r-1";
    const callId = "r-1:model:1";

    // 1. llm_input fires first — no callId yet.
    bufferPendingLlmInputForRun(state, runId, {
      prompt: "what's the weather?",
      systemPrompt: "you are helpful",
    });

    // 2. model_call_started arrives later with the callId. beginModelCall
    //    must promote the buffered input under the callId-keyed bucket.
    beginModelCall(state, runId, callId);

    // 3. lookupLlm using callId now returns the captured input.
    const got = lookupLlm(state, callId, runId);
    expect(got.input?.prompt).toBe("what's the weather?");
    expect(got.input?.systemPrompt).toBe("you are helpful");

    // 4. Pending buffer is cleared so the next turn's llm_input doesn't
    //    accidentally promote stale data.
    expect(state.pendingLlmInputByRun.get(runId)).toBeUndefined();
  });

  test("multi-turn agent: each llm_input/model_call_started pair attributes to its own callId", () => {
    // Tool-loop agent: model→tool→model. Each model call has its own callId.
    // The first turn's input must NOT bleed into the second turn's callId.
    const state = createWeaveHookState();
    const runId = "r-1";
    const callId1 = "r-1:model:1";
    const callId2 = "r-1:model:2";

    // Turn 1.
    bufferPendingLlmInputForRun(state, runId, { prompt: "first prompt" });
    beginModelCall(state, runId, callId1);
    captureLlmOutput(state, callId1, { assistantTexts: ["thinking..."] });

    // Turn 2.
    bufferPendingLlmInputForRun(state, runId, { prompt: "second prompt" });
    beginModelCall(state, runId, callId2);

    // Each callId resolves to its own input.
    expect(lookupLlm(state, callId1, runId).input?.prompt).toBe("first prompt");
    expect(lookupLlm(state, callId2, runId).input?.prompt).toBe("second prompt");
  });

  test("model_call_started without a buffered llm_input is a no-op (does not crash)", () => {
    const state = createWeaveHookState();
    const runId = "r-1";
    const callId = "r-1:model:1";
    beginModelCall(state, runId, callId);
    const got = lookupLlm(state, callId, runId);
    expect(got.input).toBeUndefined();
  });

  test("buffer ignores empty runId silently", () => {
    const state = createWeaveHookState();
    bufferPendingLlmInputForRun(state, "", { prompt: "x" });
    expect(state.pendingLlmInputByRun.size).toBe(0);
  });
});
