// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./config.js";

// apiKey resolution is delegated to OpenClaw's resolveConfiguredSecretInputString, which reads
// SecretRefs through the operator's configured `secrets.providers`. With an empty config, literal
// strings and env SecretRefs (provider "default") resolve; file/exec need a configured provider.
// These tests cover the plugin's contract (literal, env resolves, unresolved throws, undefined),
// not OpenClaw's env/file/exec internals, which OpenClaw tests itself.
const ctx = (env: NodeJS.ProcessEnv = {}) => ({ config: {} as OpenClawConfig, env });

describe("resolveConfig", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("resolves a literal apiKey (authSource=literal)", async () => {
    const cfg = await resolveConfig({ project: "p", apiKey: "literal-key" }, ctx());
    expect(cfg.apiKey).toBe("literal-key");
    expect(cfg.authSource).toBe("literal");
  });

  it("resolves an env SecretRef through OpenClaw's resolver (authSource=env:ID)", async () => {
    const cfg = await resolveConfig(
      { project: "p", apiKey: { source: "env", provider: "default", id: "WEAVE_TEST_KEY" } },
      ctx({ WEAVE_TEST_KEY: "from-env" }),
    );
    expect(cfg.apiKey).toBe("from-env");
    expect(cfg.authSource).toBe("env:WEAVE_TEST_KEY");
  });

  it("throws when a configured SecretRef cannot be resolved (unset env)", async () => {
    await expect(
      resolveConfig(
        { project: "p", apiKey: { source: "env", provider: "default", id: "WEAVE_UNSET_TEST_KEY" } },
        ctx({}),
      ),
    ).rejects.toThrow(/WEAVE_UNSET_TEST_KEY/);
  });

  it("throws for a file SecretRef when no file provider is configured", async () => {
    await expect(
      resolveConfig(
        { project: "p", apiKey: { source: "file", provider: "default", id: "/tmp/weave-missing" } },
        ctx(),
      ),
    ).rejects.toThrow();
  });

  it("leaves apiKey/authSource undefined when apiKey is unset", async () => {
    const cfg = await resolveConfig({ project: "p" }, ctx());
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.authSource).toBeUndefined();
  });

  it("builds projectId from entity, leaving it bare (never $USER) for SDK resolution when unset", async () => {
    process.env.USER = "rgao"; // guard: entity must never silently default to $USER
    const withEntity = await resolveConfig({ entity: "ent", project: "proj" }, ctx());
    expect(withEntity.entity).toBe("ent");
    expect(withEntity.projectId).toBe("ent/proj");

    const bare = await resolveConfig({ project: "proj" }, ctx());
    expect(bare.entity).toBeUndefined();
    expect(bare.projectId).toBe("proj");
  });

  it("requires project (throws when unset or empty)", async () => {
    await expect(resolveConfig({ project: "" }, ctx())).rejects.toThrow(/project/);
    await expect(resolveConfig({ project: "   " }, ctx())).rejects.toThrow(/project/);
    // @ts-expect-error project is required by the type, not just at runtime
    await expect(resolveConfig({}, ctx())).rejects.toThrow(/project/);
  });

  it("resolves captureContent (defaults to true; honors explicit true/false)", async () => {
    expect((await resolveConfig({ project: "p" }, ctx())).captureContent).toBe(true);
    expect((await resolveConfig({ project: "p", captureContent: true }, ctx())).captureContent).toBe(true);
    expect((await resolveConfig({ project: "p", captureContent: false }, ctx())).captureContent).toBe(false);
  });

  it("resolves agentVersion (PACKAGE_VERSION by default; <pkg>+<timestamp> for 'auto')", async () => {
    const def = await resolveConfig({ project: "p" }, ctx());
    expect(def.agentVersion).not.toMatch(/\+/);
    expect(def.agentVersion).toMatch(/^\d+\.\d+\.\d+/);

    const auto = await resolveConfig({ project: "p", agentVersion: "auto" }, ctx());
    expect(auto.agentVersion).toMatch(/^[^+]+\+\d{14}$/);
  });

  it("clamps flushIntervalMs to a minimum of 1000", async () => {
    const cfg = await resolveConfig({ project: "p", flushIntervalMs: 200 }, ctx());
    expect(cfg.flushIntervalMs).toBe(1000);
  });
});
