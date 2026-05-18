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
 * Translate an OTLP export error into a human-readable message plus an
 * optional one-line hint. The message is always `err.message` (or
 * `String(err)`), preserved verbatim — the hint is *appended* by the
 * caller, never substituted.
 *
 * Hint heuristics target the error shapes the OTLP exporter actually
 * produces:
 *   - `OTLPExporterError` from the http-transport has a numeric `.code`
 *     equal to the HTTP status.
 *   - The fetch-transport throws a plain `Error` whose message is
 *     `Fetch request failed with non-retryable status <NNN>`.
 *   - Network errors arrive with libuv-style codes embedded in the
 *     message (`ENOTFOUND`, `ECONNREFUSED`, `EAI_AGAIN`, `ETIMEDOUT`).
 *
 * Exported for tests.
 *
 * @internal
 */
export function describeExportError(
  err: unknown,
): { message: string; hint?: string } {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  const status = extractHttpStatus(err, message);
  if (status === 401 || status === 403) {
    return {
      message,
      hint: "check WANDB_API_KEY is valid and has access to the configured entity/project",
    };
  }
  if (status === 404) {
    return {
      message,
      hint: "endpoint URL not found; verify wandbBaseUrl (or WANDB_BASE_URL env) / wfTraceServerUrl (or WF_TRACE_SERVER_URL env) resolves to a real traces URL",
    };
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return { message, hint: "Weave backend returned 5xx; retries continue" };
  }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/.test(message)) {
    return { message, hint: "network error reaching Weave; check DNS/proxy/egress" };
  }
  return { message };
}

function extractHttpStatus(err: unknown, message: string): number | undefined {
  if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "number") {
    return (err as { code: number }).code;
  }
  const m = /non-retryable status (\d{3})/.exec(message);
  const captured = m?.[1];
  if (captured !== undefined) return Number.parseInt(captured, 10);
  return undefined;
}

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
    const { message: msg, hint } = describeExportError(err);
    const hintSuffix = hint ? `\nweave: hint: ${hint}` : "";
    if (windowStart === 0 || t - windowStart > windowMs) {
      // New window. If previous window suppressed any, report them.
      if (suppressed > 0) {
        opts.onWarn(
          `weave: ${suppressed} additional export failures suppressed in last window. New failure: ${msg}${hintSuffix}`,
        );
      } else {
        opts.onWarn(`weave: export failure: ${msg}${hintSuffix}`);
      }
      windowStart = t;
      suppressed = 0;
      warnedThisWindow = true;
      return;
    }
    if (!warnedThisWindow) {
      opts.onWarn(`weave: export failure: ${msg}${hintSuffix}`);
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
