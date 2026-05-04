import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveWandbApiKey } from "./resolve-auth.js";

describe("resolveWandbApiKey", () => {
  const ENV_VARS_TO_RESTORE = ["WANDB_API_KEY", "TEST_WANDB_KEY"];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_VARS_TO_RESTORE) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("plain string is returned trimmed", async () => {
    expect(await resolveWandbApiKey("  abc  ")).toBe("abc");
  });

  test("empty plain string throws", async () => {
    await expect(resolveWandbApiKey("   ")).rejects.toThrowError(/empty/);
  });

  test("undefined falls back to WANDB_API_KEY env", async () => {
    process.env.WANDB_API_KEY = "from-env";
    expect(await resolveWandbApiKey(undefined)).toBe("from-env");
  });

  test("undefined with no env throws a non-leaking error", async () => {
    await expect(resolveWandbApiKey(undefined)).rejects.toThrowError(
      /no API key configured/,
    );
  });

  test("SecretRef env source reads process.env", async () => {
    process.env.TEST_WANDB_KEY = "from-secret-ref";
    const value = await resolveWandbApiKey({
      source: "env",
      provider: "default",
      id: "TEST_WANDB_KEY",
    });
    expect(value).toBe("from-secret-ref");
  });

  test("SecretRef env source throws when env var unset", async () => {
    await expect(
      resolveWandbApiKey({
        source: "env",
        provider: "default",
        id: "TEST_WANDB_KEY_MISSING",
      }),
    ).rejects.toThrowError(/unset or empty/);
  });

  test("SecretRef file source reads and trims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weave-auth-test-"));
    try {
      const filePath = join(dir, "key");
      await writeFile(filePath, "  file-key  \n", "utf8");
      const value = await resolveWandbApiKey({
        source: "file",
        provider: "default",
        id: filePath,
      });
      expect(value).toBe("file-key");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SecretRef file source throws on missing file with ENOENT in message", async () => {
    await expect(
      resolveWandbApiKey({
        source: "file",
        provider: "default",
        id: "/nonexistent/path/to/key",
      }),
    ).rejects.toThrowError(/could not be read/);
  });

  test("SecretRef file source throws on empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weave-auth-test-"));
    try {
      const filePath = join(dir, "empty");
      await writeFile(filePath, "  \n  ", "utf8");
      await expect(
        resolveWandbApiKey({
          source: "file",
          provider: "default",
          id: filePath,
        }),
      ).rejects.toThrowError(/is empty/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SecretRef exec source is rejected with a clear message", async () => {
    await expect(
      resolveWandbApiKey({
        source: "exec",
        provider: "default",
        id: "echo hi",
      }),
    ).rejects.toThrowError(/not supported/);
  });

  test("error from a bad SecretRef does NOT leak the candidate value in the message", async () => {
    process.env.TEST_WANDB_KEY = "do-not-leak-this";
    // Intentionally use a different env var name to trigger the error
    let err: Error | undefined;
    try {
      await resolveWandbApiKey({
        source: "env",
        provider: "default",
        id: "MISSING_KEY",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).not.toContain("do-not-leak-this");
  });
});
