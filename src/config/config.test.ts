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

  it("resolves apiKey + authSource from literal, env, and file SecretRefs", async () => {
    const literal = await resolveConfig({ entity: "e", project: "p", apiKey: "literal-key" });
    expect(literal.apiKey).toBe("literal-key");
    expect(literal.authSource).toBe("literal");

    process.env.WEAVE_TEST_KEY = "from-env";
    const env = await resolveConfig({
      entity: "e",
      project: "p",
      apiKey: { source: "env", id: "WEAVE_TEST_KEY", provider: "x" } as any,
    });
    expect(env.apiKey).toBe("from-env");
    expect(env.authSource).toBe("env:WEAVE_TEST_KEY");

    const dir = mkdtempSync(join(tmpdir(), "weave-cfg-"));
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "from-file\n");
    const file = await resolveConfig({
      entity: "e",
      project: "p",
      apiKey: { source: "file", id: keyFile, provider: "x" } as any,
    });
    expect(file.apiKey).toBe("from-file");
    expect(file.authSource).toBe(`file:${keyFile}`);
    unlinkSync(keyFile);
  });

  it("rejects unusable apiKey SecretRefs (unset env, unsupported source, missing/empty file)", async () => {
    const base = { entity: "e", project: "p" };
    delete process.env.MISSING_TEST_VAR;
    await expect(
      resolveConfig({ ...base, apiKey: { source: "env", id: "MISSING_TEST_VAR", provider: "x" } as any }),
    ).rejects.toThrow(/MISSING_TEST_VAR/);
    await expect(
      resolveConfig({ ...base, apiKey: { source: "exec", id: "x", provider: "x" } as any }),
    ).rejects.toThrow(/use "env" or "file"/);
    await expect(
      resolveConfig({ ...base, apiKey: { source: "file", id: "/tmp/weave-missing-" + Date.now(), provider: "x" } as any }),
    ).rejects.toThrow();

    const dir = mkdtempSync(join(tmpdir(), "weave-cfg-empty-"));
    const emptyFile = join(dir, "key");
    writeFileSync(emptyFile, "");
    await expect(
      resolveConfig({ ...base, apiKey: { source: "file", id: emptyFile, provider: "x" } as any }),
    ).rejects.toThrow(/empty/);
    unlinkSync(emptyFile);
  });

  it("builds projectId from entity, leaving it bare (never $USER) for SDK resolution when unset", async () => {
    process.env.USER = "rgao"; // must never be used as the entity
    const withEntity = await resolveConfig({ entity: "ent", project: "proj" });
    expect(withEntity.entity).toBe("ent");
    expect(withEntity.projectId).toBe("ent/proj");

    const bare = await resolveConfig({ project: "proj" });
    expect(bare.entity).toBeUndefined();
    expect(bare.projectId).toBe("proj");

    const defaulted = await resolveConfig({});
    expect(defaulted.project).toBe("openclaw-default");
    expect(defaulted.projectId).toBe("openclaw-default");
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
