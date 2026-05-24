// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, expect, test } from "vitest";
import { detectOutputType } from "./output-type.js";

describe("detectOutputType", () => {
  test("returns undefined when lastAssistant is undefined", () => {
    expect(detectOutputType(undefined)).toBeUndefined();
  });

  test("returns undefined when lastAssistant is null", () => {
    expect(detectOutputType(null)).toBeUndefined();
  });

  test("returns undefined when lastAssistant is not an object", () => {
    expect(detectOutputType("string")).toBeUndefined();
    expect(detectOutputType(42)).toBeUndefined();
  });

  test("returns 'text' for plain string content", () => {
    expect(detectOutputType({ content: "hello" })).toBe("text");
  });

  test("returns undefined for empty string content", () => {
    expect(detectOutputType({ content: "" })).toBeUndefined();
  });

  test("returns 'text' for content array with only text parts", () => {
    expect(
      detectOutputType({ content: [{ type: "text", text: "hi" }] }),
    ).toBe("text");
  });

  test("returns 'image' when any content part is type:image", () => {
    expect(
      detectOutputType({
        content: [
          { type: "text", text: "here is the chart" },
          { type: "image", source: { data: "..." } },
        ],
      }),
    ).toBe("image");
  });

  test("returns 'speech' when any part is type:audio", () => {
    expect(
      detectOutputType({ content: [{ type: "audio", source: {} }] }),
    ).toBe("speech");
  });

  test("returns 'speech' when any part is type:speech", () => {
    expect(
      detectOutputType({ content: [{ type: "speech", source: {} }] }),
    ).toBe("speech");
  });

  test("returns 'json' when only tool_use parts are present (no text)", () => {
    expect(
      detectOutputType({
        content: [{ type: "tool_use", input: { foo: "bar" } }],
      }),
    ).toBe("json");
  });

  test("returns 'text' when both tool_use and text parts present (text wins)", () => {
    expect(
      detectOutputType({
        content: [
          { type: "text", text: "calling tool" },
          { type: "tool_use", input: { foo: "bar" } },
        ],
      }),
    ).toBe("text");
  });

  test("returns 'text' when reasoning + text parts (reasoning ignored, text wins)", () => {
    expect(
      detectOutputType({
        content: [
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "answer" },
        ],
      }),
    ).toBe("text");
  });

  test("returns undefined when only reasoning parts (no actionable output)", () => {
    expect(
      detectOutputType({
        content: [{ type: "thinking", thinking: "reasoning only" }],
      }),
    ).toBeUndefined();
  });

  test("returns undefined for empty content array", () => {
    expect(detectOutputType({ content: [] })).toBeUndefined();
  });

  test("image precedence beats speech and text", () => {
    expect(
      detectOutputType({
        content: [
          { type: "text", text: "x" },
          { type: "audio", source: {} },
          { type: "image", source: {} },
        ],
      }),
    ).toBe("image");
  });
});
