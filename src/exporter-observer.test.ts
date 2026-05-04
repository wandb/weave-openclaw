import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, test, vi } from "vitest";
import { createExporterObserver } from "./exporter-observer.js";

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
