// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { WeaveStatusSnapshot } from "../service.js";

/**
 * Render a `WeaveStatusSnapshot` into the multi-line text body returned by the
 * `/weave status` command. The format is deliberately compact and grep-able
 * (one `key: value` per line) so operators can paste it into bug reports.
 *
 * `now` is injected so tests get deterministic relative timestamps; production
 * passes `Date.now()`. All snapshot timestamps are ms-epoch.
 */
export function formatWeaveStatus(
  snap: WeaveStatusSnapshot,
  now: number = Date.now(),
): string {
  const lines: string[] = [];
  lines.push(`weave-openclaw v${snap.pluginVersion}`);
  lines.push(`state: ${formatLifecycle(snap, now)}`);

  if (snap.config) {
    const c = snap.config;
    lines.push(`project: ${c.entity}/${c.project}`);
    if (c.uiUrl) lines.push(`dashboard: ${c.uiUrl}`);
    lines.push(`service: ${c.serviceName}`);
    if (c.agentVersion) lines.push(`agentVersion: ${c.agentVersion}`);
    lines.push(`auth: ${c.authSource}`);
    lines.push(
      `flushIntervalMs: ${c.flushIntervalMs}  stripSenderWrapper: ${c.stripSenderWrapper}`,
    );
    lines.push(`captureContent: ${c.captureSummary}`);
  }

  if (snap.lifecycle === "running") {
    lines.push(`activeSpans: ${snap.activeSpans}`);
  }

  return lines.join("\n");
}

function formatLifecycle(snap: WeaveStatusSnapshot, now: number): string {
  switch (snap.lifecycle) {
    case "running": {
      const since = snap.startedAt !== undefined
        ? ` (since ${formatRelative(snap.startedAt, now)})`
        : "";
      return `running${since}`;
    }
    case "disabled":
      return snap.lifecycleDetail
        ? `disabled — ${snap.lifecycleDetail}`
        : "disabled";
    case "config-error":
      return snap.lifecycleDetail
        ? `config-error — ${snap.lifecycleDetail}`
        : "config-error";
    case "not-started":
      return "not-started";
    case "stopped":
      return "stopped";
  }
}

/**
 * Format a ms-epoch timestamp as `<ISO> (Ns/Nm/Nh ago)`. Operators get both
 * the absolute time (paste-into-bug-report) and the relative offset
 * ("is this stale?") in one line.
 */
function formatRelative(ts: number, now: number): string {
  const iso = new Date(ts).toISOString();
  const deltaMs = Math.max(0, now - ts);
  return `${iso} (${formatDuration(deltaMs)} ago)`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}
