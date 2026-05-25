// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect } from "vitest";
import { createRegistries } from "./registries.js";

describe("createRegistries", () => {
  it("returns seven empty Maps covering every span-handle kind plus the per-run side channels", () => {
    const r = createRegistries();
    expect(r.sessions.size).toBe(0);
    expect(r.turns.size).toBe(0);
    expect(r.calls.size).toBe(0);
    expect(r.tools.size).toBe(0);
    expect(r.subagents.size).toBe(0);
    expect(r.chatCallsByRun.size).toBe(0);
    expect(r.assistantOutputByRun.size).toBe(0);
  });
});
