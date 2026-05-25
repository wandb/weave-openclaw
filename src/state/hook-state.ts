// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { setBoundedMap } from "../util/bounded-map.js";

/**
 * Shared state across the plugin's hook subscriptions and the diagnostic-event
 * service. Hooks fire from the OpenClaw runtime (registered in `register(api)`)
 * and capture rich payloads — prompts, token usage, tool arguments, tool
 * results — that the diagnostic event stream does NOT carry.
 *
 * The service later attaches this captured data to spans when the matching
 * model.call.completed / tool.execution.completed event fires.
 *
 * Keys:
 *   - llmInputs: keyed by **callId** so multi-turn agents
 *     (`model→tool→model→tool→model`) attribute prompts to the correct chat
 *     span. The llm_input hook payload does NOT carry callId —
 *     `currentCallByRun` bridges runId → currently-in-flight callId,
 *     populated by the `model_call_started` hook (which does carry callId).
 *   - toolCallArgs / toolCallResults: keyed by toolCallId, which is unique
 *     per call.
 *
 * Assistant output is run-scoped (not call-scoped), so it lives in
 * `registries.assistantOutputByRun` rather than here.
 */

const MAX_CALLS = 4096;
const MAX_TOOL_CALLS = 4096;
const MAX_RUNS_TO_TRACK = 4096;

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

export type WeaveHookState = {
  /** callId -> input capture from llm_input hook. */
  llmInputs: Map<string, LlmInputCapture>;
  /**
   * runId -> currently-in-flight callId. Set by `model_call_started` hook,
   * read by `llm_input` (which doesn't carry callId) so captures land under
   * the correct callId-keyed bucket.
   */
  currentCallByRun: Map<string, string>;
  /**
   * runId -> llm_input capture that arrived BEFORE `model_call_started`.
   * The OpenClaw runtime fires `llm_input` first (so the prompt is captured
   * before the model is invoked), then `model_call_started` with the callId.
   * The buffer holds the input until `beginModelCall` promotes it under the
   * callId-keyed bucket. One entry per runId because a single run can only
   * have one in-flight model call at a time.
   */
  pendingLlmInputByRun: Map<string, LlmInputCapture>;
  toolCallArgs: Map<string, ToolCallArgsCapture>;
  toolCallResults: Map<string, ToolCallResultCapture>;
};

export function createWeaveHookState(): WeaveHookState {
  return {
    llmInputs: new Map(),
    currentCallByRun: new Map(),
    pendingLlmInputByRun: new Map(),
    toolCallArgs: new Map(),
    toolCallResults: new Map(),
  };
}

/**
 * Record the in-flight callId for a runId. Called from the
 * `model_call_started` hook so subsequent llm_input/llm_output captures (which
 * lack callId) can stamp themselves with the correct id.
 *
 * If `bufferPendingLlmInputForRun` was already called for this runId (the
 * common case — `llm_input` fires before `model_call_started`), the buffered
 * input is moved into the callId-keyed `llmInputs` bucket and the buffer entry
 * cleared so the next turn's input doesn't promote stale data.
 */
export function beginModelCall(
  state: WeaveHookState,
  runId: string,
  callId: string,
): void {
  if (!runId || !callId) return;
  setBoundedMap(state.currentCallByRun, runId, callId, MAX_RUNS_TO_TRACK);
  const pending = state.pendingLlmInputByRun.get(runId);
  if (pending) {
    setBoundedMap(state.llmInputs, callId, pending, MAX_CALLS);
    state.pendingLlmInputByRun.delete(runId);
  }
}

/**
 * Buffer an `llm_input` capture under the runId until the matching
 * `model_call_started` hook arrives with the callId. Called from the
 * `llm_input` hook handler when no callId has been registered yet.
 *
 * The buffer holds at most one entry per runId — a fresh `llm_input` for a
 * still-pending runId overwrites the prior pending entry. This is correct
 * because a single run can have only one in-flight model call at a time:
 * `model_call_started` always arrives between turns to promote and clear the
 * prior entry.
 */
export function bufferPendingLlmInputForRun(
  state: WeaveHookState,
  runId: string,
  capture: LlmInputCapture,
): void {
  if (!runId) return;
  setBoundedMap(state.pendingLlmInputByRun, runId, capture, MAX_RUNS_TO_TRACK);
}

/**
 * Resolve the current callId for a runId, used by llm_input/llm_output hooks
 * to find their callId-keyed bucket. Returns undefined when no model call is
 * in flight (e.g. hook ordering edge-case where llm_input fires before
 * model_call_started). Callers that get undefined should drop the capture
 * silently — the alternative (storing under runId) corrupts later calls.
 */
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
  setBoundedMap(state.llmInputs, callId, capture, MAX_CALLS);
}

export function captureToolStart(
  state: WeaveHookState,
  toolCallId: string,
  capture: ToolCallArgsCapture,
): void {
  if (!toolCallId) return;
  setBoundedMap(state.toolCallArgs, toolCallId, capture, MAX_TOOL_CALLS);
}

export function captureToolEnd(
  state: WeaveHookState,
  toolCallId: string,
  capture: ToolCallResultCapture,
): void {
  if (!toolCallId) return;
  setBoundedMap(state.toolCallResults, toolCallId, capture, MAX_TOOL_CALLS);
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

