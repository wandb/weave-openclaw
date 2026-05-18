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
      endpoint: "https://trace.wandb.ai/agents/otel/v1/traces",
      serviceName: "openclaw-agent",
      agentVersion: "0.0.1",
      flushIntervalMs: 5000,
      captureSummary: "full",
      emitGenAiAliases: true,
      stripSenderWrapper: false,
      authSource: "env",
      uiUrl: "https://wandb.ai/rgao/openclaw-default/weave",
    },
    exportStats: {
      exportsSucceeded: 7,
      exportsFailed: 0,
      spansExported: 42,
      lastSuccessAt: NOW - 1500,
    },
    ...overrides,
  };
}

describe("formatWeaveStatus", () => {
  test("running snapshot includes endpoint, project, ui url, and counters", () => {
    const out = formatWeaveStatus(snap(), NOW);
    expect(out).toContain("weave-openclaw v0.0.1");
    expect(out).toMatch(/state: running \(since/);
    expect(out).toContain("project: rgao/openclaw-default");
    expect(out).toContain("endpoint: https://trace.wandb.ai/agents/otel/v1/traces");
    expect(out).toContain("dashboard: https://wandb.ai/rgao/openclaw-default/weave");
    expect(out).toContain("auth: env");
    expect(out).toContain("captureContent: full");
    expect(out).toContain("exports: 7 ok, 0 failed, 42 spans sent");
    expect(out).toContain("lastSuccess: 2026-05-18T11:59:58.500Z (1s ago)");
    expect(out).toContain("activeSpans: 0");
    expect(out).not.toContain("lastFailure:");
  });

  test("lastSuccess: never when no successful export yet", () => {
    const s = snap({
      exportStats: {
        exportsSucceeded: 0,
        exportsFailed: 0,
        spansExported: 0,
      },
    });
    const out = formatWeaveStatus(s, NOW);
    expect(out).toContain("lastSuccess: never");
  });

  test("last-failure line includes message and hint when present", () => {
    const s = snap({
      exportStats: {
        exportsSucceeded: 0,
        exportsFailed: 1,
        spansExported: 0,
        lastFailureAt: NOW - 30_000,
        lastFailureMessage: "Unauthorized",
        lastFailureHint: "check WANDB_API_KEY is valid",
      },
    });
    const out = formatWeaveStatus(s, NOW);
    expect(out).toMatch(/lastFailure: .* — Unauthorized/);
    expect(out).toContain("hint: check WANDB_API_KEY is valid");
  });

  test("disabled snapshot shows lifecycle reason and omits exporter line", () => {
    const s: WeaveStatusSnapshot = {
      pluginVersion: "0.0.1",
      lifecycle: "disabled",
      lifecycleDetail: "config.enabled=false",
      activeSpans: 0,
    };
    const out = formatWeaveStatus(s, NOW);
    expect(out).toContain("state: disabled — config.enabled=false");
    expect(out).not.toContain("project:");
    expect(out).not.toContain("exports:");
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

  test("running snapshot without exporter stats prints injection hint", () => {
    const s = snap({ exportStats: undefined });
    const out = formatWeaveStatus(s, NOW);
    expect(out).toContain("exports: (no observer wired)");
  });

  test("formatDuration handles minutes/hours/days correctly", () => {
    const s = snap({ startedAt: NOW - (2 * 60 + 30) * 60_000 });
    const out = formatWeaveStatus(s, NOW);
    expect(out).toMatch(/since .* \(2h 30m ago\)/);
  });
});
