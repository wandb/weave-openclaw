// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { Message, Usage } from "weave";
import type { HandlerDeps } from "./deps.js";
import { dbg } from "../util/dbg.js"; // DEBUG[weave-msg-trace]

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
  const callIds = deps.registries.chatCallsByRun.get(runId);
  deps.registries.chatCallsByRun.delete(runId);
  const output = deps.registries.assistantOutputByRun.get(runId);
  deps.registries.assistantOutputByRun.delete(runId);
  if (!callIds || callIds.length === 0) return;

  const captureContent = deps.getResolved()?.captureContent ?? false;
  const texts = output?.texts ?? [];
  const usage = toUsage(output?.usage);

  dbg(
    `closeRunChatSpans runId=${runId} chatCount=${callIds.length} ` +
      `assistantTextCount=${texts.length} usagePresent=${usage ? "y" : "n"} ` +
      `captureContent=${captureContent}`,
    deps.instanceId,
  );

  for (let i = 0; i < callIds.length; i++) {
    const callId = callIds[i]!;
    const h = deps.registries.calls.get(callId);
    if (!h) continue;
    const isLast = i === callIds.length - 1;
    const capIn = deps.hookState.llmInputs.get(callId);
    // Positional attribution: i-th chat span gets the i-th assistant text.
    // If the model emitted more texts than tracked chat spans (shouldn't
    // happen, but be defensive), fold the surplus into the final span so
    // the user-visible answer never silently disappears.
    const text =
      i < texts.length
        ? texts[i]
        : isLast && texts.length > 0
          ? texts[texts.length - 1]
          : undefined;
    const shaped = shapeMessages({ input: capIn, text }, captureContent);
    const recordUsage = isLast ? usage : undefined;
    if (shaped.input.length || shaped.output.length || recordUsage) {
      h.llm.record({
        inputMessages: shaped.input,
        outputMessages: shaped.output,
        ...(recordUsage ? { usage: recordUsage } : {}),
      });
    }
    h.llm.end(
      h.status === "error"
        ? { error: new Error(h.errorType ?? "model.call.error") }
        : undefined,
    );
    deps.registries.calls.delete(callId);
    deps.hookState.llmInputs.delete(callId);
    deps.hookState.llmOutputs.delete(callId);
  }
}

function shapeMessages(
  cap: {
    input?: { systemPrompt?: string; prompt: string; historyMessages?: unknown[] };
    text?: string;
  },
  captureContent: boolean,
): { input: Message[]; output: Message[] } {
  const out: { input: Message[]; output: Message[] } = { input: [], output: [] };
  if (captureContent && cap.input) {
    if (cap.input.systemPrompt) {
      out.input.push({ role: "system", content: cap.input.systemPrompt });
    }
    if (Array.isArray(cap.input.historyMessages)) {
      for (const m of cap.input.historyMessages) {
        if (m && typeof m === "object" && "role" in m && "content" in m) {
          out.input.push(m as Message);
        }
      }
    }
    if (cap.input.prompt) {
      out.input.push({ role: "user", content: cap.input.prompt });
    }
  }
  if (captureContent && typeof cap.text === "string" && cap.text.length > 0) {
    out.output.push({ role: "assistant", content: cap.text });
  }
  return out;
}

function toUsage(u: unknown): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const x = u as Record<string, unknown>;
  const usage: Usage = {
    inputTokens: typeof x.input === "number" ? x.input : undefined,
    outputTokens: typeof x.output === "number" ? x.output : undefined,
    reasoningTokens: typeof x.reasoning === "number" ? x.reasoning : undefined,
    cacheReadInputTokens: typeof x.cacheRead === "number" ? x.cacheRead : undefined,
    cacheCreationInputTokens: typeof x.cacheWrite === "number" ? x.cacheWrite : undefined,
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
