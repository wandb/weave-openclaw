// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { BoundedMap } from "../util/bounded-map.js";

// Capture buffers shared between hooks and the diagnostic service: hooks hold
// payloads (prompts, usage, tool args/results) the event stream doesn't carry.

export type LlmInputCapture = {
  systemPrompt?: string;
  prompt: string;
  historyMessages?: unknown[];
};

export type ToolCallArgsCapture = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
};

export type ToolCallResultCapture = {
  result?: unknown;
};

export type AssistantOutputBuffer = {
  texts: string[];
  usage?: unknown;
};

export type WeaveHookState = {
  llmInputs: BoundedMap<string, LlmInputCapture>; // keyed by callId, not runId
  currentCallByRun: BoundedMap<string, string>;
  // llm_input that arrived before model_call_started; promoted once callId is known
  pendingLlmInputByRun: BoundedMap<string, LlmInputCapture>;
  toolCallArgs: BoundedMap<string, ToolCallArgsCapture>;
  toolCallResults: BoundedMap<string, ToolCallResultCapture>;
  chatCallsByRun: BoundedMap<string, string[]>;
  assistantOutputByRun: BoundedMap<string, AssistantOutputBuffer>;
};

export function createWeaveHookState(): WeaveHookState {
  return {
    llmInputs: new BoundedMap(),
    currentCallByRun: new BoundedMap(),
    pendingLlmInputByRun: new BoundedMap(),
    toolCallArgs: new BoundedMap(),
    toolCallResults: new BoundedMap(),
    chatCallsByRun: new BoundedMap(),
    assistantOutputByRun: new BoundedMap(),
  };
}

export function beginModelCall(
  state: WeaveHookState,
  runId: string,
  callId: string,
): void {
  if (!runId || !callId) return;
  state.currentCallByRun.set(runId, callId);
  const pending = state.pendingLlmInputByRun.get(runId);
  if (pending) {
    state.llmInputs.set(callId, pending);
    state.pendingLlmInputByRun.delete(runId);
  }
}

export function bufferPendingLlmInputForRun(
  state: WeaveHookState,
  runId: string,
  capture: LlmInputCapture,
): void {
  if (!runId) return;
  state.pendingLlmInputByRun.set(runId, capture);
}

export function resolveCurrentCallId(
  state: WeaveHookState,
  runId: string | undefined,
): string | undefined {
  if (!runId) return undefined;
  return state.currentCallByRun.get(runId);
}

export function captureLlmInput(
  state: WeaveHookState,
  callId: string,
  capture: LlmInputCapture,
): void {
  if (!callId) return;
  state.llmInputs.set(callId, capture);
}

export function captureToolStart(
  state: WeaveHookState,
  toolCallId: string,
  capture: ToolCallArgsCapture,
): void {
  if (!toolCallId) return;
  state.toolCallArgs.set(toolCallId, capture);
}

export function captureToolEnd(
  state: WeaveHookState,
  toolCallId: string,
  capture: ToolCallResultCapture,
): void {
  if (!toolCallId) return;
  state.toolCallResults.set(toolCallId, capture);
}

export function lookupToolCall(
  state: WeaveHookState,
  toolCallId: string | undefined,
): { args?: ToolCallArgsCapture; result?: ToolCallResultCapture } {
  if (!toolCallId) return {};
  return {
    args: state.toolCallArgs.get(toolCallId),
    result: state.toolCallResults.get(toolCallId),
  };
}
