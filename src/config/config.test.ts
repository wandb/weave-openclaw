// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./config.js";

// apiKey resolution is delegated to OpenClaw's resolveConfiguredSecretInputString, which reads
// SecretRefs through the operator's configured `secrets.providers`. With an empty config, literal
// strings and env SecretRefs (provider "default") resolve; file/exec need a configured provider.
// These tests cover the plugin's contract, not OpenClaw's env/file/exec internals (OpenClaw's own).
const ctx = (env: NodeJS.ProcessEnv = {}) => ({ config: {} as OpenClawConfig, env });
const base = { entity: "my-team", project: "my-project" };

describe("resolveConfig", () => {
  it("resolves apiKey + authSource (literal, env SecretRef; undefined when unset)", async () => {
    const literal = await resolveConfig({ ...base, apiKey: "literal-key" }, ctx());
    expect(literal.apiKey).toBe("literal-key");
    expect(literal.authSource).toBe("literal");

    const env = await resolveConfig(
      { ...base, apiKey: { source: "env", provider: "default", id: "WEAVE_TEST_KEY" } },
      ctx({ WEAVE_TEST_KEY: "from-env" }),
    );
    expect(env.apiKey).toBe("from-env");
    expect(env.authSource).toBe("env:WEAVE_TEST_KEY");

    const unset = await resolveConfig(base, ctx());
    expect(unset.apiKey).toBeUndefined();
    expect(unset.authSource).toBeUndefined();
  });

  it("throws when a configured apiKey SecretRef cannot be resolved", async () => {
    await expect(
      resolveConfig(
        { ...base, apiKey: { source: "env", provider: "default", id: "WEAVE_UNSET_TEST_KEY" } },
        ctx({}),
      ),
    ).rejects.toThrow(/WEAVE_UNSET_TEST_KEY/);
    // file source with no configured provider cannot resolve
    await expect(
      resolveConfig(
        { ...base, apiKey: { source: "file", provider: "default", id: "/tmp/weave-missing" } },
        ctx(),
      ),
    ).rejects.toThrow();
  });

  it("requires entity and project; builds projectId as entity/project", async () => {
    await expect(resolveConfig({ entity: "", project: "my-project" }, ctx())).rejects.toThrow(/entity/);
    await expect(resolveConfig({ entity: "  ", project: "my-project" }, ctx())).rejects.toThrow(/entity/);
    await expect(resolveConfig({ entity: "my-team", project: "" }, ctx())).rejects.toThrow(/project/);
    await expect(resolveConfig({ entity: "my-team", project: "  " }, ctx())).rejects.toThrow(/project/);
    // @ts-expect-error entity and project are required by the type, not just at runtime
    await expect(resolveConfig({}, ctx())).rejects.toThrow(/entity|project/);

    const cfg = await resolveConfig({ entity: "my-team", project: "my-project" }, ctx());
    expect(cfg.entity).toBe("my-team");
    expect(cfg.projectId).toBe("my-team/my-project");
  });

  it("applies field defaults (captureContent, agentVersion, flush clamp)", async () => {
    const def = await resolveConfig(base, ctx());
    expect(def.captureContent).toBe(true);
    expect(def.agentVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(def.agentVersion).not.toMatch(/\+/);

    expect((await resolveConfig({ ...base, captureContent: false }, ctx())).captureContent).toBe(false);

    expect((await resolveConfig({ ...base, flushIntervalMs: 200 }, ctx())).flushIntervalMs).toBe(1000);
  });
});
