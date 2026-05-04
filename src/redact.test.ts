import { describe, expect, it } from "vitest";
import {
  sanitizeAttrJson,
  sanitizeAttrJsonWithFlag,
  sanitizeAttrString,
  sanitizeAttrStringWithFlag,
  shrinkJsonValueToFit,
} from "./redact.js";

// Mirrors `MAX_ATTRIBUTE_CHARS` in `redact.ts`. Tests scale their input
// sizes accordingly so the over-budget paths still exercise.
const MAX = 256 * 1024;

describe("sanitizeAttrJsonWithFlag — small input fits intact", () => {
  it("array of small messages serializes unchanged with truncated=false", () => {
    const messages = [
      { role: "user", content: "Hello world", finish_reason: "" },
      { role: "assistant", content: "Hi there!", finish_reason: "stop" },
    ];
    const r = sanitizeAttrJsonWithFlag(messages);
    expect(r).toBeDefined();
    expect(r!.truncated).toBe(false);
    expect(JSON.parse(r!.value)).toEqual(messages);
  });

  it("string root under budget passes through", () => {
    const r = sanitizeAttrJsonWithFlag("plain text");
    expect(r).toBeDefined();
    expect(r!.truncated).toBe(false);
    expect(JSON.parse(r!.value)).toBe("plain text");
  });
});

describe("sanitizeAttrJsonWithFlag — over-budget input is structurally truncated", () => {
  it("single message with huge content: outer array stays parseable, content shrunk", () => {
    // Single-item array: the only item IS the protected tail. Phase 1 has
    // nothing else to shrink, Phase 2 can't drop (length 1), Phase 3 falls
    // back to shrinking the protected item — verify it still produces
    // valid JSON with the truncation marker.
    const huge = "x".repeat(400_000);
    const messages = [{ role: "user", content: huge, finish_reason: "" }];
    const r = sanitizeAttrJsonWithFlag(messages);
    expect(r).toBeDefined();
    expect(r!.truncated).toBe(true);
    // Crucial: the result must be valid JSON (json.loads on the server side).
    const parsed = JSON.parse(r!.value);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].role).toBe("user");
    expect(parsed[0].finish_reason).toBe("");
    expect(typeof parsed[0].content).toBe("string");
    expect(parsed[0].content).toMatch(/…\[truncated \d+c\]$/);
    expect(r!.value.length).toBeLessThanOrEqual(MAX);
  });

  it("many messages whose total exceeds budget: keeps recent ones, drops oldest", () => {
    // 25 messages (under MAX_ARRAY_ITEMS=256 so walk doesn't trim them) but
    // each carrying ~12 KiB → ~300 KiB serialized, comfortably over MAX.
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message-${i}-${"x".repeat(12_000)}`,
      finish_reason: "",
    }));
    const r = sanitizeAttrJsonWithFlag(messages);
    expect(r).toBeDefined();
    expect(r!.truncated).toBe(true);
    const parsed = JSON.parse(r!.value);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    // Latest messages preserved (drop is from the head — keep the most
    // recent turn, which is the most useful context for the in-flight call).
    const last = parsed[parsed.length - 1];
    expect(last.content).toContain("message-24");
    expect(r!.value.length).toBeLessThanOrEqual(MAX);
  });

  it("the realistic plugin shape: array with one normal message + one huge tool-result", () => {
    // Mirrors the openclaw-plugin-weave failure case: a few small history
    // items followed by one toolResult message whose content is a 6000+
    // char skill description — the byte-truncate strategy used to clip
    // mid-string and break json.loads on the server.
    const messages = [
      { role: "user", content: "Hello", finish_reason: "" },
      { role: "assistant", content: "Hi!", finish_reason: "stop" },
      { role: "user", content: "search weather", finish_reason: "" },
      {
        role: "toolResult",
        content: `# Weather Skill\n${"a".repeat(400_000)}`,
        finish_reason: "",
      },
      { role: "assistant", content: "On it.", finish_reason: "stop" },
    ];
    const r = sanitizeAttrJsonWithFlag(messages);
    expect(r).toBeDefined();
    expect(r!.truncated).toBe(true);
    const parsed = JSON.parse(r!.value);
    // The structure must remain a parseable list of message dicts.
    expect(Array.isArray(parsed)).toBe(true);
    for (const m of parsed) {
      expect(typeof m.role).toBe("string");
      expect(typeof m.content).toBe("string");
      expect(typeof m.finish_reason).toBe("string");
    }
    expect(r!.value.length).toBeLessThanOrEqual(MAX);
  });

  it("primitive string root over budget: char-truncated with marker", () => {
    const huge = "x".repeat(400_000);
    const r = sanitizeAttrJsonWithFlag(huge);
    expect(r).toBeDefined();
    expect(r!.truncated).toBe(true);
    const parsed = JSON.parse(r!.value);
    expect(typeof parsed).toBe("string");
    expect(parsed).toMatch(/…\[truncated \d+c\]$/);
    expect(r!.value.length).toBeLessThanOrEqual(MAX);
  });
});

describe("sanitizeAttrJson (non-flag wrapper) returns same value as withFlag", () => {
  it("forwards the value of sanitizeAttrJsonWithFlag", () => {
    const messages = [{ role: "user", content: "hi", finish_reason: "" }];
    expect(sanitizeAttrJson(messages)).toBe(
      sanitizeAttrJsonWithFlag(messages)!.value,
    );
  });

  it("returns undefined for null/undefined like before", () => {
    expect(sanitizeAttrJson(null)).toBeUndefined();
    expect(sanitizeAttrJson(undefined)).toBeUndefined();
  });
});

describe("sanitizeAttrString (unchanged byte-truncate, but verify still works)", () => {
  it("under budget passes through", () => {
    expect(sanitizeAttrString("hello")).toBe("hello");
  });
  it("over budget byte-truncates with marker — server's _normalize_system_instructions falls back to wrapping this in an array, so byte-truncation is acceptable for plain string columns", () => {
    const huge = "x".repeat(400_000);
    const r = sanitizeAttrStringWithFlag(huge);
    expect(r).toBeDefined();
    expect(r!.truncated).toBe(true);
    expect(r!.value).toMatch(/…\[truncated \d+c\]$/);
    expect(r!.value.length).toBeLessThanOrEqual(MAX + 24);
  });
});

describe("walk array trim (regression: previously dropped the latest user prompt)", () => {
  it("preserves the LAST item (in-flight user prompt) when array exceeds MAX_ARRAY_ITEMS", () => {
    // Regression: previously `walk` did `slice(0, N)` and silently dropped
    // the in-flight user prompt whenever history exceeded the soft cap.
    // After fix, slice(-N) keeps the most recent items (and structural
    // truncation, if it kicks in on size, also drops oldest-first).
    const cap = 256;
    const messages = Array.from({ length: cap + 5 }, (_, i) => ({
      role: i === cap + 4 ? "user" : "assistant",
      content: i === cap + 4 ? "does sf have vow renewal?" : `t${i}`,
      finish_reason: "",
    }));
    const r = sanitizeAttrJsonWithFlag(messages);
    expect(r).toBeDefined();
    const parsed = JSON.parse(r!.value);
    expect(Array.isArray(parsed)).toBe(true);
    // Latest user prompt survives at the tail — this is what users see in
    // the trace as "the user said this turn." Whether the marker survives
    // a subsequent structural-truncation pass is an implementation detail.
    const last = parsed[parsed.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("does sf have vow renewal?");
  });

  it("typical 48-message conversation is NOT trimmed by walk (under the cap)", () => {
    // 48 messages — the case from the live trace — should pass through
    // walk unchanged so no fake "…[16 more]" marker shows up.
    const messages = Array.from({ length: 48 }, (_, i) => ({
      role: i === 47 ? "user" : "assistant",
      content: i === 47 ? "does sf have vow renewal?" : `turn ${i}`,
      finish_reason: "",
    }));
    const r = sanitizeAttrJsonWithFlag(messages);
    const parsed = JSON.parse(r!.value);
    expect(parsed.length).toBe(48);
    expect(parsed[parsed.length - 1].content).toBe("does sf have vow renewal?");
    // No marker string should appear anywhere — every entry is a dict.
    for (const m of parsed) expect(typeof m).toBe("object");
  });
});

describe("shrinkJsonValueToFit (internal helper) terminates and produces valid JSON", () => {
  it("never produces unparseable JSON regardless of input (tight 8 KiB budget)", () => {
    // Use a tight budget here so each case actually exercises the shrink
    // path. With the production 256 KiB budget these inputs fit untouched.
    const tight = 8 * 1024;
    const cases: unknown[] = [
      "x".repeat(50_000),
      Array.from({ length: 500 }, (_, i) => ({ role: "user", content: "y".repeat(200), finish_reason: String(i) })),
      { tool_args: { city: "Paris", description: "x".repeat(15_000) } },
      [{ role: "user", content: "x".repeat(30_000), finish_reason: "" }],
    ];
    for (const c of cases) {
      const out = shrinkJsonValueToFit(JSON.parse(JSON.stringify(c)), tight);
      const serialized = JSON.stringify(out);
      // Parseable.
      expect(() => JSON.parse(serialized)).not.toThrow();
    }
  });

  it("preserves the in-flight tail user prompt intact when phase 1 can shrink other strings to fit", () => {
    // Regression: live trace had ~9 messages including a long Chinese
    // assistant turn + tool results, with a short user prompt at the tail
    // ("can you plan a two day seattle trip…"). Pre-fix, byte-shrink halved
    // the tail user prompt down to MIN_STRING_KEEP_AFTER_SHRINK chars and
    // the user saw their own question truncated in the trace UI. The
    // three-phase shrink protects the last array item: Phase 1 halves
    // earlier strings only, so the tail survives intact whenever the
    // budget can be met without touching it.
    const userPrompt =
      "can you plan a two day seattle trip for me? for instagram worth";
    const messages = [
      { role: "user", content: "earlier", finish_reason: "" },
      { role: "assistant", content: "x".repeat(6_000), finish_reason: "stop" },
      { role: "toolResult", content: "y".repeat(6_000), finish_reason: "" },
      { role: "user", content: userPrompt, finish_reason: "" },
    ];
    // Tight 8 KiB budget forces shrinking. Total before shrink ~12.5 KiB.
    const out = shrinkJsonValueToFit(
      JSON.parse(JSON.stringify(messages)),
      8 * 1024,
    ) as Array<{ role: string; content: string }>;
    expect(Array.isArray(out)).toBe(true);
    // The tail entry must survive byte-for-byte.
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe(userPrompt);
    expect(last.content).not.toMatch(/…\[truncated/);
    // And the whole thing must fit the budget.
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(8 * 1024);
  });
});
