// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { Message, Usage } from "weave";
import type { HandlerDeps } from "./deps.js";

/**
 * Close every chat span tracked under `runId`. Called from `onRunFinalize`
 * (run.completed).
 *
 * Deferred close is necessary because OpenClaw's `llm_input`/`llm_output`
 * hooks fire ONCE PER ATTEMPT, not per model.call: a single attempt with
 * `model→tool→model` produces two `model.call.*` cycles but only one
 * `llm_output` (carrying all assistantTexts). Closing on
 * `model.call.completed` would emit chat spans without their content;
 * waiting for an attempt-scoped `llm_output` per chat span (the previous
 * two-signal design) never fires for intermediate calls.
 *
 * Input is keyed by callId (only the first call usually has one — `llm_input`
 * is buffered then promoted by `model_call_started`). Output texts arrive at
 * run scope; we attribute them positionally to chat spans, folding any extras
 * into the last span so the user-visible answer is never dropped.
 */
export function closeRunChatSpans(deps: HandlerDeps, runId: string): void {
  const callIds = deps.hookState.chatCallsByRun.get(runId);
  deps.hookState.chatCallsByRun.delete(runId);
  const output = deps.hookState.assistantOutputByRun.get(runId);
  deps.hookState.assistantOutputByRun.delete(runId);
  if (!callIds || callIds.length === 0) return;

  const captureContent = deps.getResolved()?.captureContent ?? false;
  const texts = output?.texts ?? [];
  const usage = toUsage(output?.usage);

  // Length mismatch is a load-bearing assumption that the runtime fires
  // exactly one llm_output text per model.call we tracked. Warn loud so we
  // notice drift in production rather than silently mis-attributing.
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
    // Positional attribution: i-th chat span gets the i-th assistant text.
    // When lengths don't match we fall back to behavior that preserves the
    // user-visible answer, and the warn above flags it:
    //   - Surplus (N > M): last span absorbs texts[M-1..N-1] joined.
    //   - Scarcity (N < M): last span pads with texts[N-1] so the answer
    //     still appears on at least one span when the runtime aggregated
    //     everything into fewer texts than we tracked spans.
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
        if (m && typeof m === "object" && "role" in m && "content" in m) {
          out.input.push(m as Message);
        }
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

function toUsage(rawUsage: unknown): Usage | undefined {
  if (!rawUsage || typeof rawUsage !== "object") return undefined;
  const fields = rawUsage as Record<string, unknown>;
  const usage: Usage = {
    inputTokens: typeof fields.input === "number" ? fields.input : undefined,
    outputTokens: typeof fields.output === "number" ? fields.output : undefined,
    reasoningTokens: typeof fields.reasoning === "number" ? fields.reasoning : undefined,
    cacheReadInputTokens: typeof fields.cacheRead === "number" ? fields.cacheRead : undefined,
    cacheCreationInputTokens: typeof fields.cacheWrite === "number" ? fields.cacheWrite : undefined,
  };
  // Drop if nothing useful was set.
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.reasoningTokens === undefined &&
    usage.cacheReadInputTokens === undefined &&
    usage.cacheCreationInputTokens === undefined
  ) {
    return undefined;
  }
  return usage;
}
