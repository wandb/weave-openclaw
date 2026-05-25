// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { LLM, Session, SubAgent, Tool, Turn } from "weave";

/**
 * Soft cap on each registry's size. Defends against unbounded growth when
 * an event stream is interrupted (gateway crash, dropped conversation).
 * Maps preserve insertion order; setBoundedMap evicts the oldest first.
 */
export const MAX_ENTRIES = 4096;

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

export type AssistantOutputBuffer = {
  texts: string[];
  usage?: unknown;
};

export type Registries = {
  sessions: Map<string, Session>;
  turns: Map<string, Turn>;
  calls: Map<string, LLMHandle>;
  tools: Map<string, Tool>;
  subagents: Map<string, SubAgent>;
  /** Ordered callIds per runId. Used at run.completed to attach output texts. */
  chatCallsByRun: Map<string, string[]>;
  /** Assistant texts + usage captured at run scope by the llm_output hook. */
  assistantOutputByRun: Map<string, AssistantOutputBuffer>;
};

export function createRegistries(): Registries {
  return {
    sessions: new Map(),
    turns: new Map(),
    calls: new Map(),
    tools: new Map(),
    subagents: new Map(),
    chatCallsByRun: new Map(),
    assistantOutputByRun: new Map(),
  };
}
