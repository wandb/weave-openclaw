// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { LLM, Session, SubAgent, Tool, Turn } from "weave";
import { BoundedMap } from "../util/bounded-map.js";

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
  sessions: BoundedMap<string, Session>;
  turns: BoundedMap<string, Turn>;
  calls: BoundedMap<string, LLMHandle>;
  tools: BoundedMap<string, Tool>;
  subagents: BoundedMap<string, SubAgent>;
};

export function createRegistries(): Registries {
  return {
    sessions: new BoundedMap(),
    turns: new BoundedMap(),
    calls: new BoundedMap(),
    tools: new BoundedMap(),
    subagents: new BoundedMap(),
  };
}
