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

  it("uses literal apiKey when provided as string", async () => {
    const cfg = await resolveConfig({ entity: "ent", project: "proj", apiKey: "literal-key" });
    expect(cfg.apiKey).toBe("literal-key");
    expect(cfg.authSource).toBe("literal");
  });

  it("resolves apiKey from env SecretRef", async () => {
    process.env.WEAVE_TEST_KEY = "from-env";
    const cfg = await resolveConfig({
      entity: "ent",
      project: "proj",
      apiKey: { source: "env", id: "WEAVE_TEST_KEY", provider: "x" } as any,
    });
    expect(cfg.apiKey).toBe("from-env");
    expect(cfg.authSource).toBe("env:WEAVE_TEST_KEY");
  });

  it("resolves apiKey from file SecretRef", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weave-cfg-"));
    const f = join(dir, "key");
    writeFileSync(f, "from-file\n");
    const cfg = await resolveConfig({
      entity: "ent",
      project: "proj",
      apiKey: { source: "file", id: f, provider: "x" } as any,
    });
    expect(cfg.apiKey).toBe("from-file");
    expect(cfg.authSource).toBe(`file:${f}`);
    unlinkSync(f);
  });

  it("throws when env SecretRef references unset var", async () => {
    delete process.env.MISSING_TEST_VAR;
    await expect(
      resolveConfig({
        entity: "ent",
        project: "proj",
        apiKey: { source: "env", id: "MISSING_TEST_VAR", provider: "x" } as any,
      }),
    ).rejects.toThrow(/MISSING_TEST_VAR/);
  });

  it("defaults entity to $USER and project to openclaw-default", async () => {
    process.env.USER = "rgao";
    const cfg = await resolveConfig({});
    expect(cfg.entity).toBe("rgao");
    expect(cfg.project).toBe("openclaw-default");
  });

  it("parses captureContent: true as on", async () => {
    const cfg = await resolveConfig({ entity: "e", project: "p", captureContent: true });
    expect(cfg.captureContent).toBe(true);
  });

  it("parses captureContent: false as off", async () => {
    const cfg = await resolveConfig({ entity: "e", project: "p", captureContent: false });
    expect(cfg.captureContent).toBe(false);
  });

  it("defaults captureContent to true when omitted", async () => {
    const cfg = await resolveConfig({ entity: "e", project: "p" });
    expect(cfg.captureContent).toBe(true);
  });

  it("clamps flushIntervalMs to a min of 1000", async () => {
    const cfg = await resolveConfig({ entity: "e", project: "p", flushIntervalMs: 200 });
    expect(cfg.flushIntervalMs).toBe(1000);
  });

  it("expands agentVersion 'auto' to PACKAGE_VERSION+timestamp", async () => {
    const cfg = await resolveConfig({ entity: "e", project: "p", agentVersion: "auto" });
    // Form: <pkg>+<14-digit-ISO-timestamp>. We don't assert the pkg version
    // string (it's whatever version.ts ships), only the structure.
    expect(cfg.agentVersion).toMatch(/^[^+]+\+\d{14}$/);
  });

  it("returns PACKAGE_VERSION when agentVersion is undefined", async () => {
    const cfg = await resolveConfig({ entity: "e", project: "p" });
    // PACKAGE_VERSION is plain semver, no '+' suffix.
    expect(cfg.agentVersion).not.toMatch(/\+/);
    expect(cfg.agentVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("throws when file SecretRef references a missing path", async () => {
    const missing = "/tmp/weave-config-test-this-should-not-exist-" + Date.now();
    await expect(
      resolveConfig({
        entity: "e",
        project: "p",
        apiKey: { source: "file", id: missing, provider: "x" } as any,
      }),
    ).rejects.toThrow();
  });

  it("throws when SecretRef uses unsupported 'exec' source", async () => {
    await expect(
      resolveConfig({
        entity: "e",
        project: "p",
        apiKey: { source: "exec", id: "anything", provider: "x" } as any,
      }),
    ).rejects.toThrow(/use "env" or "file"/);
  });

  it("throws when file SecretRef references an empty file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weave-cfg-empty-"));
    const f = join(dir, "key");
    writeFileSync(f, "");
    try {
      await expect(
        resolveConfig({
          entity: "e",
          project: "p",
          apiKey: { source: "file", id: f, provider: "x" } as any,
        }),
      ).rejects.toThrow(/empty/);
    } finally {
      unlinkSync(f);
    }
  });
});
