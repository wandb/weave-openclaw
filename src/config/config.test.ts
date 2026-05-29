// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  // OpenClaw hands plugins SecretRefs ({ source, provider, id }) UNRESOLVED, so the plugin
  // resolves them itself. Only source "env"/"file" is supported (the apiKey enum in
  // openclaw.plugin.json); `id` is read directly as the env var name / file path and `provider`
  // is unused. "file" is an OpenClaw mounted-secret file, not W&B netrc. "exec" is a valid
  // SecretRefSource the plugin rejects (resolving it needs provider command/sandbox config a
  // bare ref can't carry).
  it("resolves apiKey + authSource from literal, env, and file SecretRefs", async () => {
    const literal = await resolveConfig({ entity: "e", project: "p", apiKey: "literal-key" });
    expect(literal.apiKey).toBe("literal-key");
    expect(literal.authSource).toBe("literal");

    process.env.WEAVE_TEST_KEY = "from-env";
    const env = await resolveConfig({
      entity: "e",
      project: "p",
      apiKey: { source: "env", id: "WEAVE_TEST_KEY", provider: "default" },
    });
    expect(env.apiKey).toBe("from-env");
    expect(env.authSource).toBe("env:WEAVE_TEST_KEY");

    const dir = mkdtempSync(join(tmpdir(), "weave-cfg-"));
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "from-file\n");
    const file = await resolveConfig({
      entity: "e",
      project: "p",
      apiKey: { source: "file", id: keyFile, provider: "default" },
    });
    expect(file.apiKey).toBe("from-file");
    expect(file.authSource).toBe(`file:${keyFile}`);
    unlinkSync(keyFile);
  });

  it("rejects unusable apiKey SecretRefs (unset env, unsupported source, missing/empty file)", async () => {
    const base = { entity: "e", project: "p" };
    // env SecretRef pointing at a deliberately-unset variable must throw.
    delete process.env.WEAVE_UNSET_TEST_KEY;
    await expect(
      resolveConfig({ ...base, apiKey: { source: "env", id: "WEAVE_UNSET_TEST_KEY", provider: "default" } }),
    ).rejects.toThrow(/WEAVE_UNSET_TEST_KEY/);
    // "exec" is a real SecretRefSource but unsupported here (enum is env/file) — reject clearly.
    await expect(
      resolveConfig({ ...base, apiKey: { source: "exec", id: "x", provider: "default" } }),
    ).rejects.toThrow(/use "env" or "file"/);
    await expect(
      resolveConfig({ ...base, apiKey: { source: "file", id: "/tmp/weave-missing-" + Date.now(), provider: "default" } }),
    ).rejects.toThrow();

    const dir = mkdtempSync(join(tmpdir(), "weave-cfg-empty-"));
    const emptyFile = join(dir, "key");
    writeFileSync(emptyFile, "");
    await expect(
      resolveConfig({ ...base, apiKey: { source: "file", id: emptyFile, provider: "default" } }),
    ).rejects.toThrow(/empty/);
    unlinkSync(emptyFile);
  });

  it("builds projectId from entity, leaving it bare (never $USER) for SDK resolution when unset", async () => {
    process.env.USER = "rgao"; // guard: entity must never silently default to $USER
    const withEntity = await resolveConfig({ entity: "ent", project: "proj" });
    expect(withEntity.entity).toBe("ent");
    expect(withEntity.projectId).toBe("ent/proj");

    const bare = await resolveConfig({ project: "proj" });
    expect(bare.entity).toBeUndefined();
    expect(bare.projectId).toBe("proj");
  });

  it("requires project (throws when unset or empty)", async () => {
    await expect(resolveConfig({ project: "" })).rejects.toThrow(/project/);
    await expect(resolveConfig({ project: "   " })).rejects.toThrow(/project/);
    // @ts-expect-error project is required by the type, not just at runtime
    await expect(resolveConfig({})).rejects.toThrow(/project/);
  });

  it("resolves captureContent (defaults to true; honors explicit true/false)", async () => {
    expect((await resolveConfig({ entity: "e", project: "p" })).captureContent).toBe(true);
    expect((await resolveConfig({ entity: "e", project: "p", captureContent: true })).captureContent).toBe(true);
    expect((await resolveConfig({ entity: "e", project: "p", captureContent: false })).captureContent).toBe(false);
  });

  it("resolves agentVersion (PACKAGE_VERSION by default; <pkg>+<timestamp> for 'auto')", async () => {
    const def = await resolveConfig({ entity: "e", project: "p" });
    expect(def.agentVersion).not.toMatch(/\+/);
    expect(def.agentVersion).toMatch(/^\d+\.\d+\.\d+/);

    const auto = await resolveConfig({ entity: "e", project: "p", agentVersion: "auto" });
    expect(auto.agentVersion).toMatch(/^[^+]+\+\d{14}$/);
  });

  it("clamps flushIntervalMs to a minimum of 1000", async () => {
    const cfg = await resolveConfig({ entity: "e", project: "p", flushIntervalMs: 200 });
    expect(cfg.flushIntervalMs).toBe(1000);
  });
});
