import { describe, expect, test } from "vitest";
import { stableAgentId } from "./agent-id.js";

describe("stableAgentId", () => {
  test("returns deterministic 8-char hex hash for the same inputs", () => {
    const a = stableAgentId("acme", "agents", "research");
    const b = stableAgentId("acme", "agents", "research");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  test("different harnessId produces a different hash", () => {
    expect(stableAgentId("acme", "agents", "research")).not.toBe(
      stableAgentId("acme", "agents", "writer"),
    );
  });

  test("different entity produces a different hash (no collisions across teams)", () => {
    expect(stableAgentId("acme", "agents", "research")).not.toBe(
      stableAgentId("contoso", "agents", "research"),
    );
  });

  test("different project produces a different hash", () => {
    expect(stableAgentId("acme", "prod", "research")).not.toBe(
      stableAgentId("acme", "staging", "research"),
    );
  });

  test("falls back to 'unknown' marker when harnessId is empty or undefined", () => {
    const a = stableAgentId("acme", "agents", "");
    const b = stableAgentId("acme", "agents", undefined);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});
