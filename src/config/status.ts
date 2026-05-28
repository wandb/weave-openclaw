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
    authSource: string;
    uiUrl?: string;
  };
  counts?: { turns: number; calls: number; tools: number; subagents: number };
};

export function formatStatus(snapshot: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`weave: pluginVersion=${snapshot.pluginVersion}`);
  const lifecyclePart = snapshot.lifecycleDetail
    ? `lifecycle=${snapshot.lifecycle} (${snapshot.lifecycleDetail})`
    : `lifecycle=${snapshot.lifecycle}`;
  const startedPart = snapshot.startedAt
    ? ` started=${new Date(snapshot.startedAt).toISOString()}`
    : "";
  lines.push(`       ${lifecyclePart}${startedPart}`);
  if (snapshot.config) {
    const config = snapshot.config;
    lines.push(`       project=${config.projectId} service=${config.serviceName} agentVersion=${config.agentVersion}`);
    lines.push(
      `       auth=${config.authSource} flushIntervalMs=${config.flushIntervalMs} captureContent=${config.captureContent ? "on" : "off"}`,
    );
    if (snapshot.counts) {
      const counts = snapshot.counts;
      lines.push(`       active: turns=${counts.turns} calls=${counts.calls} tools=${counts.tools} subagents=${counts.subagents}`);
    }
    if (config.uiUrl) lines.push(`       dashboard ${config.uiUrl}`);
  }
  return lines.join("\n");
}
