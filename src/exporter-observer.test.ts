// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, test, vi } from "vitest";
import { createExporterObserver, describeExportError } from "./exporter-observer.js";

// Inline the OTel ExportResultCode enum values so we don't have to direct-dep
// @opentelemetry/core. Stable: 0=SUCCESS, 1=FAILED.
const SUCCESS = 0 as const;
const FAILED = 1 as const;

function makeFakeExporter(outcomes: Array<"ok" | Error>): SpanExporter {
  let i = 0;
  return {
    export(_spans: ReadableSpan[], cb) {
      const o = outcomes[Math.min(i++, outcomes.length - 1)];
      if (o === "ok") cb({ code: SUCCESS } as never);
      else cb({ code: FAILED, error: o } as never);
    },
    async shutdown() {},
  };
}

async function exportOnce(
  observed: SpanExporter,
  spans: ReadableSpan[] = [],
): Promise<void> {
  await new Promise<void>((res) => observed.export(spans, () => res()));
}

function fakeSpan(): ReadableSpan {
  return {} as ReadableSpan;
}

describe("createExporterObserver", () => {
  test("forwards successful exports without warnings", async () => {
    const inner = makeFakeExporter(["ok", "ok"]);
    const warn = vi.fn();
    const { exporter } = createExporterObserver(inner, { onWarn: warn });
    await exportOnce(exporter);
    await exportOnce(exporter);
    expect(warn).not.toHaveBeenCalled();
  });

  test("logs once on first failure within window", async () => {
    const inner = makeFakeExporter([
      new Error("network fail"),
      new Error("network fail"),
    ]);
    const warn = vi.fn();
    const { exporter } = createExporterObserver(inner, {
      onWarn: warn,
      windowMs: 60_000,
      now: () => 1000,
    });
    await exportOnce(exporter);
    await exportOnce(exporter);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("network fail");
  });

  test("logs again after the window elapses", async () => {
    const inner = makeFakeExporter([
      new Error("err1"),
      new Error("err2"),
      new Error("err3"),
    ]);
    const warn = vi.fn();
    let now = 1000;
    const { exporter } = createExporterObserver(inner, {
      onWarn: warn,
      windowMs: 60_000,
      now: () => now,
    });
    await exportOnce(exporter);
    now = 1000 + 60_001;
    await exportOnce(exporter);
    await exportOnce(exporter);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("logs suppression count when window closes after multiple failures", async () => {
    const inner = makeFakeExporter([
      new Error("err1"),
      new Error("err2"),
      new Error("err3"),
      new Error("err4"),
    ]);
    const warn = vi.fn();
    let now = 1000;
    const { exporter } = createExporterObserver(inner, {
      onWarn: warn,
      windowMs: 60_000,
      now: () => now,
    });
    await exportOnce(exporter);
    await exportOnce(exporter);
    await exportOnce(exporter);
    now = 1000 + 60_001;
    await exportOnce(exporter);
    expect(warn).toHaveBeenCalledTimes(2);
    // Second warn carries the suppression count from window 1.
    expect(warn.mock.calls[1][0]).toContain("suppressed");
    expect(warn.mock.calls[1][0]).toContain("2");
  });

  test("forwards shutdown to inner exporter", async () => {
    const innerShutdown = vi.fn(async () => {});
    const inner: SpanExporter = {
      export(_s, cb) {
        cb({ code: SUCCESS } as never);
      },
      shutdown: innerShutdown,
    };
    const { exporter } = createExporterObserver(inner, { onWarn: vi.fn() });
    await exporter.shutdown();
    expect(innerShutdown).toHaveBeenCalled();
  });

  test("forwards forceFlush when inner exporter supports it", async () => {
    const innerFlush = vi.fn(async () => {});
    const inner: SpanExporter = {
      export(_s, cb) {
        cb({ code: SUCCESS } as never);
      },
      shutdown: async () => {},
      forceFlush: innerFlush,
    };
    const { exporter } = createExporterObserver(inner, { onWarn: vi.fn() });
    expect(exporter.forceFlush).toBeDefined();
    await exporter.forceFlush!();
    expect(innerFlush).toHaveBeenCalled();
  });

  test("getStats counts successes, failures, spans, and last timestamps", async () => {
    const inner = makeFakeExporter([
      "ok",
      "ok",
      new Error("boom"),
      "ok",
    ]);
    let now = 1000;
    const { exporter, getStats } = createExporterObserver(inner, {
      onWarn: vi.fn(),
      now: () => now,
    });
    await exportOnce(exporter, [fakeSpan(), fakeSpan()]);
    now = 2000;
    await exportOnce(exporter, [fakeSpan()]);
    now = 3000;
    await exportOnce(exporter);
    now = 4000;
    await exportOnce(exporter, [fakeSpan(), fakeSpan(), fakeSpan()]);
    const stats = getStats();
    expect(stats.exportsSucceeded).toBe(3);
    expect(stats.exportsFailed).toBe(1);
    expect(stats.spansExported).toBe(6);
    expect(stats.lastSuccessAt).toBe(4000);
    expect(stats.lastFailureAt).toBe(3000);
    expect(stats.lastFailureMessage).toBe("boom");
  });

  test("getStats captures last failure hint when error is recognisable", async () => {
    const inner = makeFakeExporter([
      Object.assign(new Error("Unauthorized"), { code: 401 }),
    ]);
    const { exporter, getStats } = createExporterObserver(inner, {
      onWarn: vi.fn(),
    });
    await exportOnce(exporter);
    const stats = getStats();
    expect(stats.lastFailureMessage).toBe("Unauthorized");
    expect(stats.lastFailureHint).toMatch(/WANDB_API_KEY/);
  });

  test("getStats returns a snapshot (mutations do not leak back)", async () => {
    const inner = makeFakeExporter(["ok"]);
    const { exporter, getStats } = createExporterObserver(inner, {
      onWarn: vi.fn(),
    });
    await exportOnce(exporter, [fakeSpan()]);
    const snap = getStats();
    snap.exportsSucceeded = 999;
    expect(getStats().exportsSucceeded).toBe(1);
  });
});

describe("describeExportError", () => {
  test("OTLPExporterError shape 401 → auth hint", () => {
    const err = Object.assign(new Error("Unauthorized"), { code: 401 });
    const { message, hint } = describeExportError(err);
    expect(message).toBe("Unauthorized");
    expect(hint).toMatch(/WANDB_API_KEY/);
  });

  test("OTLPExporterError shape 403 → auth hint", () => {
    const err = Object.assign(new Error("Forbidden"), { code: 403 });
    expect(describeExportError(err).hint).toMatch(/WANDB_API_KEY/);
  });

  test("OTLPExporterError shape 404 → endpoint hint", () => {
    const err = Object.assign(new Error("Not Found"), { code: 404 });
    expect(describeExportError(err).hint).toMatch(/endpoint/i);
  });

  test("OTLPExporterError shape 503 → backend hint", () => {
    const err = Object.assign(new Error("Service Unavailable"), { code: 503 });
    expect(describeExportError(err).hint).toMatch(/5xx/);
  });

  test("fetch-transport non-retryable status 401 → auth hint", () => {
    const err = new Error("Fetch request failed with non-retryable status 401");
    expect(describeExportError(err).hint).toMatch(/WANDB_API_KEY/);
  });

  test("fetch-transport non-retryable status 404 → endpoint hint", () => {
    const err = new Error("Fetch request failed with non-retryable status 404");
    expect(describeExportError(err).hint).toMatch(/endpoint/i);
  });

  test("network error ENOTFOUND → network hint", () => {
    const err = new Error("getaddrinfo ENOTFOUND trace.wandb.ai");
    expect(describeExportError(err).hint).toMatch(/network/i);
  });

  test("network error ECONNREFUSED → network hint", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
    expect(describeExportError(err).hint).toMatch(/network/i);
  });

  test("unrecognised error → no hint", () => {
    const err = new Error("something weird happened");
    const { message, hint } = describeExportError(err);
    expect(message).toBe("something weird happened");
    expect(hint).toBeUndefined();
  });

  test("non-Error value → string coerced, no hint", () => {
    const { message, hint } = describeExportError("plain string err");
    expect(message).toBe("plain string err");
    expect(hint).toBeUndefined();
  });
});

describe("createExporterObserver hint integration", () => {
  test("warning includes hint when error matches a heuristic", async () => {
    const inner = makeFakeExporter([
      Object.assign(new Error("Unauthorized"), { code: 401 }),
    ]);
    const warn = vi.fn();
    const { exporter } = createExporterObserver(inner, { onWarn: warn });
    await exportOnce(exporter);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("export failure: Unauthorized");
    expect(line).toContain("weave: hint: ");
    expect(line).toMatch(/WANDB_API_KEY/);
  });

  test("warning has no hint line for unrecognised errors", async () => {
    const inner = makeFakeExporter([new Error("opaque mystery")]);
    const warn = vi.fn();
    const { exporter } = createExporterObserver(inner, { onWarn: warn });
    await exportOnce(exporter);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("opaque mystery");
    expect(line).not.toContain("weave: hint:");
  });
});
