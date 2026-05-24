// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

export type StatusSnapshot = {
  pluginVersion: string;
  lifecycle: "disabled" | "not-started" | "config-error" | "running" | "stopped";
  lifecycleDetail?: string;
  startedAt?: number;
  config?: {
    projectId: string;
    serviceName: string;
    agentVersion: string;
    flushIntervalMs: number;
    captureContent: boolean;
    stripSenderWrapper: boolean;
    authSource: string;
    uiUrl?: string;
  };
  counts?: { turns: number; calls: number; tools: number; subagents: number };
};

export function formatStatus(s: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`weave: pluginVersion=${s.pluginVersion}`);
  const lifecyclePart = s.lifecycleDetail
    ? `lifecycle=${s.lifecycle} (${s.lifecycleDetail})`
    : `lifecycle=${s.lifecycle}`;
  const startedPart = s.startedAt
    ? ` started=${new Date(s.startedAt).toISOString()}`
    : "";
  lines.push(`       ${lifecyclePart}${startedPart}`);
  if (s.config) {
    const c = s.config;
    lines.push(`       project=${c.projectId} service=${c.serviceName} agentVersion=${c.agentVersion}`);
    lines.push(
      `       auth=${c.authSource} flushIntervalMs=${c.flushIntervalMs} captureContent=${c.captureContent ? "on" : "off"}`,
    );
    if (s.counts) {
      const k = s.counts;
      lines.push(`       active: turns=${k.turns} calls=${k.calls} tools=${k.tools} subagents=${k.subagents}`);
    }
    if (c.uiUrl) lines.push(`       dashboard ${c.uiUrl}`);
  }
  return lines.join("\n");
}
