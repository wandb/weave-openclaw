import { describe, expect, test, vi } from "vitest";
import { checkSdkCompat, REQUIRED_PLUGIN_API } from "./sdk-compat.js";

describe("checkSdkCompat", () => {
  test("returns ok when api has the required methods", () => {
    const api = { on: vi.fn(), registerService: vi.fn(), pluginConfig: {} };
    const result = checkSdkCompat(api);
    expect(result.ok).toBe(true);
  });

  test("returns error with explanation when api.on is missing", () => {
    const api = { registerService: vi.fn(), pluginConfig: {} };
    const result = checkSdkCompat(api);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("api.on");
      expect(result.message).toContain(REQUIRED_PLUGIN_API);
    }
  });

  test("returns error when api.registerService is missing", () => {
    const api = { on: vi.fn(), pluginConfig: {} };
    const result = checkSdkCompat(api);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("registerService");
    }
  });

  test("returns error when api is null", () => {
    const result = checkSdkCompat(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("object");
  });

  test("returns error when api is undefined", () => {
    const result = checkSdkCompat(undefined);
    expect(result.ok).toBe(false);
  });

  test("returns error when api is a primitive", () => {
    expect(checkSdkCompat("string").ok).toBe(false);
    expect(checkSdkCompat(42).ok).toBe(false);
  });
});
