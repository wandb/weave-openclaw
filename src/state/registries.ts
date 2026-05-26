// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { LLM, Session, SubAgent, Tool, Turn } from "weave";

/**
 * Per-plugin-instance Maps from upstream OpenClaw ids to live Weave SDK
 * span handles. Pure registries — finalize events look the handle up by id
 * and call `.end()` on it. Cross-event accumulators (chat-call ordering,
 * assistant-text buffering, etc.) live in `WeaveHookState` instead.
 */

/**
 * LLM handle for an in-flight chat span. We defer close until the parent
 * `run.completed` arrives so we can attach the run-level `llm_output` content
 * (OpenClaw fires `llm_output` once per attempt with all assistantTexts, not
 * per model.call). Status/errorType are stamped when `model.call.completed` /
 * `model.call.error` fires; `end()` is deferred to `closeRunChatSpans`.
 */
export type LLMHandle = {
  llm: LLM;
  status: "ok" | "error";
  errorType?: string;
};

export type Registries = {
  sessions: Map<string, Session>;
  turns: Map<string, Turn>;
  calls: Map<string, LLMHandle>;
  tools: Map<string, Tool>;
  subagents: Map<string, SubAgent>;
};

export function createRegistries(): Registries {
  return {
    sessions: new Map(),
    turns: new Map(),
    calls: new Map(),
    tools: new Map(),
    subagents: new Map(),
  };
}
