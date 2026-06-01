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
