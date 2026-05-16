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

async function exportOnce(observed: SpanExporter): Promise<void> {
  await new Promise<void>((res) => observed.export([], () => res()));
}

describe("createExporterObserver", () => {
  test("forwards successful exports without warnings", async () => {
    const inner = makeFakeExporter(["ok", "ok"]);
    const warn = vi.fn();
    const observed = createExporterObserver(inner, { onWarn: warn });
    await exportOnce(observed);
    await exportOnce(observed);
    expect(warn).not.toHaveBeenCalled();
  });

  test("logs once on first failure within window", async () => {
    const inner = makeFakeExporter([
      new Error("network fail"),
      new Error("network fail"),
    ]);
    const warn = vi.fn();
    const observed = createExporterObserver(inner, {
      onWarn: warn,
      windowMs: 60_000,
      now: () => 1000,
    });
    await exportOnce(observed);
    await exportOnce(observed);
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
    const observed = createExporterObserver(inner, {
      onWarn: warn,
      windowMs: 60_000,
      now: () => now,
    });
    await exportOnce(observed);
    now = 1000 + 60_001;
    await exportOnce(observed);
    await exportOnce(observed);
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
    const observed = createExporterObserver(inner, {
      onWarn: warn,
      windowMs: 60_000,
      now: () => now,
    });
    await exportOnce(observed);
    await exportOnce(observed);
    await exportOnce(observed);
    now = 1000 + 60_001;
    await exportOnce(observed);
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
    const observed = createExporterObserver(inner, { onWarn: vi.fn() });
    await observed.shutdown();
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
    const observed = createExporterObserver(inner, { onWarn: vi.fn() });
    expect(observed.forceFlush).toBeDefined();
    await observed.forceFlush!();
    expect(innerFlush).toHaveBeenCalled();
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
    const observed = createExporterObserver(inner, { onWarn: warn });
    await exportOnce(observed);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("export failure: Unauthorized");
    expect(line).toContain("weave: hint: ");
    expect(line).toMatch(/WANDB_API_KEY/);
  });

  test("warning has no hint line for unrecognised errors", async () => {
    const inner = makeFakeExporter([new Error("opaque mystery")]);
    const warn = vi.fn();
    const observed = createExporterObserver(inner, { onWarn: warn });
    await exportOnce(observed);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("opaque mystery");
    expect(line).not.toContain("weave: hint:");
  });
});
