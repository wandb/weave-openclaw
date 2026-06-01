// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect } from "vitest";
import { formatStatus } from "./status.js";

describe("formatStatus", () => {
  it("renders a running snapshot with config, counts, and dashboard link", () => {
    const out = formatStatus({
      lifecycle: "running",
      startedAt: 1716480251000,
      pluginVersion: "0.0.1",
      config: {
        projectId: "my-team/openclaw-default",
        serviceName: "openclaw-agent",
        agentVersion: "0.0.1+20260523150411",
        flushIntervalMs: 5000,
        captureContent: true,
        authSource: "env:WANDB_API_KEY",
        uiUrl: "https://wandb.ai/my-team/openclaw-default/weave",
      },
      counts: { turns: 3, calls: 1, tools: 0, subagents: 0 },
    });
    expect(out).toMatchInlineSnapshot(`
      "weave: pluginVersion=0.0.1
             lifecycle=running started=2024-05-23T16:04:11.000Z
             project=my-team/openclaw-default service=openclaw-agent agentVersion=0.0.1+20260523150411
             auth=env:WANDB_API_KEY flushIntervalMs=5000 captureContent=on
             active: turns=3 calls=1 tools=0 subagents=0
             dashboard https://wandb.ai/my-team/openclaw-default/weave"
    `);
  });

  it("shows lifecycle detail and omits the dashboard link when uiUrl is absent", () => {
    const disabled = formatStatus({
      lifecycle: "disabled",
      lifecycleDetail: "config.enabled=false",
      pluginVersion: "0.0.1",
    });
    expect(disabled).toContain("lifecycle=disabled");
    expect(disabled).toContain("config.enabled=false");

    const noUrl = formatStatus({
      lifecycle: "running",
      pluginVersion: "0.0.1",
      config: {
        projectId: "my-team/my-project",
        serviceName: "openclaw-agent",
        agentVersion: "0.0.1",
        flushIntervalMs: 5000,
        captureContent: false,
        authSource: "env",
      },
      counts: { turns: 0, calls: 0, tools: 0, subagents: 0 },
    });
    expect(noUrl).not.toMatch(/wandb\.ai/);
  });
});
