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
 * LLM handle with the merge-state needed for two-signal close: the
 * llm_output hook captures content while model.call.completed carries the
 * end time. Whichever fires second triggers .record(...).end().
 */
export type LLMHandle = {
  llm: LLM;
  hookDone: boolean;
  diagDone: boolean;
  endTimeMs?: number;
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
