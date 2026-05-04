// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

// ExportResultCode lives in @opentelemetry/core, which we don't direct-import
// to keep the dep list tight. The enum is API-stable: 0=SUCCESS, 1=FAILED.
// See @opentelemetry/core's ExportResult.ts.
const EXPORT_RESULT_FAILED = 1;

export type ExporterObserverOptions = {
  /** Called on each rate-limited warning. */
  onWarn: (message: string) => void;
  /** Window in ms. Default 60_000. */
  windowMs?: number;
  /** Override clock for tests. */
  now?: () => number;
};

/**
 * Wrap a SpanExporter to observe export failures with rate-limited logging.
 *
 * - Forwards `export()` and `shutdown()` unchanged so callers see the same
 *   semantics as the underlying exporter.
 * - On the FIRST failure per window (default 60s), calls `onWarn(message)`.
 * - Suppresses subsequent failures in the window; tracks count.
 * - When the next failure crosses the window boundary, logs a "<N> previously
 *   suppressed" prefix on that warning. This avoids both silent drops and
 *   per-batch noise on a flaky link.
 *
 * Successes within a window do NOT reset the window. This is deliberate: if a
 * link is degraded but occasionally succeeds, you'd otherwise re-warn on
 * every alternation. The window only advances by elapsed time.
 */
export function createExporterObserver(
  inner: SpanExporter,
  opts: ExporterObserverOptions,
): SpanExporter {
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let windowStart = 0;
  let suppressed = 0;
  let warnedThisWindow = false;

  function reportFailure(err: Error | undefined): void {
    const t = now();
    const msg = err?.message ?? String(err);
    if (windowStart === 0 || t - windowStart > windowMs) {
      // New window. If previous window suppressed any, report them.
      if (suppressed > 0) {
        opts.onWarn(
          `weave: ${suppressed} additional export failures suppressed in last window. New failure: ${msg}`,
        );
      } else {
        opts.onWarn(`weave: export failure: ${msg}`);
      }
      windowStart = t;
      suppressed = 0;
      warnedThisWindow = true;
      return;
    }
    if (!warnedThisWindow) {
      opts.onWarn(`weave: export failure: ${msg}`);
      warnedThisWindow = true;
      return;
    }
    suppressed += 1;
  }

  return {
    export(spans: ReadableSpan[], cb) {
      inner.export(spans, (result) => {
        if (result.code === EXPORT_RESULT_FAILED) {
          reportFailure((result as { error?: Error }).error);
        }
        cb(result);
      });
    },
    shutdown: inner.shutdown.bind(inner),
    ...(inner.forceFlush ? { forceFlush: inner.forceFlush.bind(inner) } : {}),
  };
}
