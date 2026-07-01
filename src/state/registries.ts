// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { Conversation, LLM, SubAgent, Tool, Turn } from "weave";
import { BoundedMap } from "../util/bounded-map.js";

// Held open until run.completed so per-attempt llm_output attaches before .end().
export type LLMHandle = {
  llm: LLM;
  status: "ok" | "error";
  errorType?: string;
};

export type Registries = {
  conversations: BoundedMap<string, Conversation>;
  turns: BoundedMap<string, Turn>;
  calls: BoundedMap<string, LLMHandle>;
  tools: BoundedMap<string, Tool>;
  subagents: BoundedMap<string, SubAgent>;
};

export function createRegistries(): Registries {
  return {
    conversations: new BoundedMap(),
    turns: new BoundedMap(),
    calls: new BoundedMap(),
    tools: new BoundedMap(),
    subagents: new BoundedMap(),
  };
}
