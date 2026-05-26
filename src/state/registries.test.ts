// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect } from "vitest";
import { createRegistries } from "./registries.js";

describe("createRegistries", () => {
  it("returns five empty Maps, one per SDK span-handle kind", () => {
    const r = createRegistries();
    expect(r.sessions.size).toBe(0);
    expect(r.turns.size).toBe(0);
    expect(r.calls.size).toBe(0);
    expect(r.tools.size).toBe(0);
    expect(r.subagents.size).toBe(0);
  });
});
