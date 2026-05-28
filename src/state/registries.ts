// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { LLM, Session, SubAgent, Tool, Turn } from "weave";
import { BoundedMap } from "../util/bounded-map.js";

// Held open until run.completed so per-attempt llm_output attaches before .end().
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
