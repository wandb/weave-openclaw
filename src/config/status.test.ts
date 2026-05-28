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
        projectId: "rgao/openclaw-default",
        serviceName: "openclaw-agent",
        agentVersion: "0.0.1+20260523150411",
        flushIntervalMs: 5000,
        captureContent: true,
        authSource: "env:WANDB_API_KEY",
        uiUrl: "https://wandb.ai/rgao/openclaw-default/weave",
      },
      counts: { turns: 3, calls: 1, tools: 0, subagents: 0 },
    });
    expect(out).toContain("project=rgao/openclaw-default");
    expect(out).toContain("lifecycle=running");
    expect(out).toContain("auth=env:WANDB_API_KEY");
    expect(out).toContain("turns=3 calls=1 tools=0 subagents=0");
    expect(out).toContain("https://wandb.ai/rgao/openclaw-default/weave");
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
        projectId: "x/y",
        serviceName: "s",
        agentVersion: "v",
        flushIntervalMs: 5000,
        captureContent: false,
        authSource: "env",
      },
      counts: { turns: 0, calls: 0, tools: 0, subagents: 0 },
    });
    expect(noUrl).not.toMatch(/wandb\.ai/);
  });
});
