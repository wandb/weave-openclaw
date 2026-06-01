// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { Message, Usage } from "weave";
import type { HandlerDeps } from "./deps.js";
import type { LlmOutputUsage } from "./hook-types.js";

// llm_input/llm_output fire once per ATTEMPT (not per model.call), so chat spans
// close here at run.completed with output texts attributed to spans positionally.
export function closeRunChatSpans(deps: HandlerDeps, runId: string): void {
  const callIds = deps.hookState.chatCallsByRun.get(runId);
  deps.hookState.chatCallsByRun.delete(runId);
  const output = deps.hookState.assistantOutputByRun.get(runId);
  deps.hookState.assistantOutputByRun.delete(runId);
  if (!callIds || callIds.length === 0) return;

  const captureContent = deps.getResolved()?.captureContent ?? false;
  const texts = output?.texts ?? [];
  const usage = toUsage(output?.usage);

  if (texts.length > 0 && texts.length !== callIds.length) {
    deps.getLogger()?.warn(
      `weave: llm_output text count (${texts.length}) did not match tracked ` +
        `chat-span count (${callIds.length}) for runId=${runId}; surplus texts ` +
        `will be folded into the last chat span. If this fires for real traffic, ` +
        `the positional attribution in closeRunChatSpans needs an upstream fix.`,
    );
  }

  for (let i = 0; i < callIds.length; i++) {
    const callId = callIds[i]!;
    const handle = deps.registries.calls.get(callId);
    if (!handle) continue;
    const isLast = i === callIds.length - 1;
    const capturedInput = deps.hookState.llmInputs.get(callId);
    // Positional; on mismatch fold surplus into / pad the last span so the answer survives.
    let text: string | undefined;
    if (isLast && texts.length > callIds.length) {
      text = texts.slice(callIds.length - 1).join("\n");
    } else if (i < texts.length) {
      text = texts[i];
    } else if (isLast && texts.length > 0) {
      text = texts[texts.length - 1];
    }
    const shaped = shapeMessages({ input: capturedInput, text }, captureContent);
    const recordUsage = isLast ? usage : undefined;
    if (shaped.input.length || shaped.output.length || recordUsage) {
      handle.llm.record({
        inputMessages: shaped.input,
        outputMessages: shaped.output,
        ...(recordUsage ? { usage: recordUsage } : {}),
      });
    }
    handle.llm.end(
      handle.status === "error"
        ? { error: new Error(handle.errorType ?? "model.call.error") }
        : undefined,
    );
    deps.registries.calls.delete(callId);
    deps.hookState.llmInputs.delete(callId);
  }
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

function toUsage(raw: LlmOutputUsage): Usage | undefined {
  if (!raw) return undefined;
  const usage: Usage = {
    inputTokens: raw.input,
    outputTokens: raw.output,
    cacheReadInputTokens: raw.cacheRead,
    cacheCreationInputTokens: raw.cacheWrite,
  };
  // Drop if nothing useful was set.
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
