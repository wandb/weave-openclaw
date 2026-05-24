// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, expect, test } from "vitest";
import type { WeaveStatusSnapshot } from "./service.js";
import { formatWeaveStatus } from "./status-format.js";

const NOW = Date.parse("2026-05-18T12:00:00Z");

function snap(overrides: Partial<WeaveStatusSnapshot> = {}): WeaveStatusSnapshot {
  return {
    pluginVersion: "0.0.1",
    lifecycle: "running",
    startedAt: NOW - 5 * 60_000,
    activeSpans: 0,
    config: {
      entity: "rgao",
      project: "openclaw-default",
      serviceName: "openclaw-agent",
      agentVersion: "0.0.1",
      flushIntervalMs: 5000,
      captureSummary: "full",
      stripSenderWrapper: false,
      authSource: "env",
      uiUrl: "https://wandb.ai/rgao/openclaw-default/weave",
    },
    ...overrides,
  };
}

describe("formatWeaveStatus", () => {
  test("running snapshot includes project, ui url, and config", () => {
    const out = formatWeaveStatus(snap(), NOW);
    expect(out).toContain("weave-openclaw v0.0.1");
    expect(out).toMatch(/state: running \(since/);
    expect(out).toContain("project: rgao/openclaw-default");
    expect(out).toContain("dashboard: https://wandb.ai/rgao/openclaw-default/weave");
    expect(out).toContain("auth: env");
    expect(out).toContain("captureContent: full");
    expect(out).toContain("activeSpans: 0");
  });

  test("disabled snapshot shows lifecycle reason and omits project line", () => {
    const s: WeaveStatusSnapshot = {
      pluginVersion: "0.0.1",
      lifecycle: "disabled",
      lifecycleDetail: "config.enabled=false",
      activeSpans: 0,
    };
    const out = formatWeaveStatus(s, NOW);
    expect(out).toContain("state: disabled — config.enabled=false");
    expect(out).not.toContain("project:");
    expect(out).not.toContain("activeSpans:");
  });

  test("config-error snapshot surfaces the detail", () => {
    const s: WeaveStatusSnapshot = {
      pluginVersion: "0.0.1",
      lifecycle: "config-error",
      lifecycleDetail: "config.entity is required",
      activeSpans: 0,
    };
    const out = formatWeaveStatus(s, NOW);
    expect(out).toContain("state: config-error — config.entity is required");
  });

  test("not-started snapshot is minimal", () => {
    const s: WeaveStatusSnapshot = {
      pluginVersion: "0.0.1",
      lifecycle: "not-started",
      activeSpans: 0,
    };
    const out = formatWeaveStatus(s, NOW);
    expect(out.split("\n")).toEqual([
      "weave-openclaw v0.0.1",
      "state: not-started",
    ]);
  });

  test("formatDuration handles minutes/hours/days correctly", () => {
    const s = snap({ startedAt: NOW - (2 * 60 + 30) * 60_000 });
    const out = formatWeaveStatus(s, NOW);
    expect(out).toMatch(/since .* \(2h 30m ago\)/);
  });
});
