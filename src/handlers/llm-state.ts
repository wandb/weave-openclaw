// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { Message, Usage } from "weave";
import type { HandlerDeps } from "./deps.js";
import type { LlmUsage } from "./hook-types.js";

// model.call.completed/error: close THIS chat span now, recording its captured
// input and output. Closing at model.call.completed (not deferring to run end) is
// what makes both the user's input and the assistant's response export mid-run, so
// they are visible while the turn is still running. The output is captured per call
// by the before_message_write hook, which fires just before model.call.completed.
export function finalizeChatSpan(
  deps: HandlerDeps,
  runId: string,
  callId: string,
  status: "ok" | "error",
  errorType: string | undefined,
): void {
  if (!closeChatSpan(deps, callId, status, errorType)) return;
  const list = deps.hookState.chatCallsByRun.get(runId);
  if (list) {
    const rest = list.filter((id) => id !== callId);
    if (rest.length) deps.hookState.chatCallsByRun.set(runId, rest);
    else deps.hookState.chatCallsByRun.delete(runId);
  }
}

// run.completed backstop: close any chat span that never saw a model.call.completed
// (e.g. an attempt that ended without one), so it never leaks open past its run.
export function finalizeRunChatSpans(deps: HandlerDeps, runId: string): void {
  const callIds = deps.hookState.chatCallsByRun.get(runId);
  deps.hookState.chatCallsByRun.delete(runId);
  deps.hookState.currentCallByRun.delete(runId);
  for (const callId of callIds ?? []) closeChatSpan(deps, callId, "ok", undefined);
}

// Close one chat span, recording its captured input and — if the
// before_message_write hook delivered it for this call — the assistant output and
// usage. Returns false when the callId has no live span.
function closeChatSpan(
  deps: HandlerDeps,
  callId: string,
  status: "ok" | "error",
  errorType: string | undefined,
): boolean {
  const handle = deps.registries.calls.get(callId);
  if (!handle) return false;
  const captureContent = deps.getResolved()?.captureContent ?? false;
  const capturedInput = deps.hookState.llmInputs.get(callId);
  const capturedOutput = deps.hookState.assistantOutputByCall.get(callId);
  const shaped = shapeMessages(
    { input: capturedInput, text: capturedOutput?.text },
    captureContent,
  );
  const usage = toUsage(capturedOutput?.usage);
  if (shaped.input.length || shaped.output.length || usage) {
    handle.llm.record({
      inputMessages: shaped.input,
      outputMessages: shaped.output,
      ...(usage ? { usage } : {}),
    });
  }
  handle.llm.end(
    status === "error"
      ? { error: new Error(errorType ?? "model.call.error") }
      : undefined,
  );
  deps.registries.calls.delete(callId);
  deps.hookState.llmInputs.delete(callId);
  deps.hookState.assistantOutputByCall.delete(callId);
  return true;
}

function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "role" in value && "content" in value;
}

function shapeMessages(
  capture: {
    input?: { systemPrompt?: string; prompt: string; historyMessages?: unknown[] };
    text?: string;
  },
  captureContent: boolean,
): { input: Message[]; output: Message[] } {
  const out: { input: Message[]; output: Message[] } = { input: [], output: [] };
  if (captureContent && capture.input) {
    if (capture.input.systemPrompt) {
      out.input.push({ role: "system", content: capture.input.systemPrompt });
    }
    if (Array.isArray(capture.input.historyMessages)) {
      for (const m of capture.input.historyMessages) {
        if (isMessage(m)) out.input.push(m);
      }
    }
    if (capture.input.prompt) {
      out.input.push({ role: "user", content: capture.input.prompt });
    }
  }
  if (captureContent && typeof capture.text === "string" && capture.text.length > 0) {
    out.output.push({ role: "assistant", content: capture.text });
  }
  return out;
}

function toUsage(raw: LlmUsage | undefined): Usage | undefined {
  if (!raw) return undefined;
  const usage: Usage = {
    inputTokens: raw.input,
    outputTokens: raw.output,
    cacheReadInputTokens: raw.cacheRead,
    cacheCreationInputTokens: raw.cacheWrite,
  };
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.cacheReadInputTokens === undefined &&
    usage.cacheCreationInputTokens === undefined
  ) {
    return undefined;
  }
  return usage;
}
