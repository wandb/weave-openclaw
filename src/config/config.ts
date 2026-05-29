// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { readFile } from "node:fs/promises";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { readEnv } from "./env.js";
import { PACKAGE_VERSION } from "./version.js";

const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const MIN_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_SERVICE_NAME = "openclaw-agent";

// Raw plugin settings from openclaw.plugin.json. `project` is required (resolveConfig throws when
// unset/empty). `entity` is optional: left undefined when unset so the Weave SDK resolves the
// account's default entity, never $USER. resolveConfig() applies defaults for the rest.
export type RawConfig = {
  enabled?: boolean;
  entity?: string;
  project: string;
  serviceName?: string;
  agentName?: string;
  agentVersion?: string;
  agentDescription?: string;
  captureContent?: boolean;
  flushIntervalMs?: number;
  apiKey?: string | SecretRef;
};

export type ResolvedConfig = {
  enabled: boolean;
  entity?: string;
  project: string;
  projectId: string;
  serviceName: string;
  agentName?: string;
  agentVersion: string;
  agentDescription?: string;
  captureContent: boolean;
  flushIntervalMs: number;
  apiKey?: string;
  authSource?: string;
};

export async function resolveConfig(raw: RawConfig): Promise<ResolvedConfig> {
  const entity = raw.entity?.trim() || undefined;
  const project = raw.project?.trim();
  if (!project) throw new Error("weave: project is required; set it in the plugin config");

  const apiKey = raw.apiKey ? await resolveApiKey(raw.apiKey) : undefined;

  const flushIntervalMs = Math.max(
    MIN_FLUSH_INTERVAL_MS,
    raw.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
  );

  return {
    enabled: raw.enabled !== false,
    entity,
    project,
    projectId: entity ? `${entity}/${project}` : project,
    serviceName: raw.serviceName || DEFAULT_SERVICE_NAME,
    agentName: raw.agentName,
    agentVersion: resolveAgentVersion(raw.agentVersion),
    agentDescription: raw.agentDescription,
    captureContent: raw.captureContent !== false,
    flushIntervalMs,
    apiKey: apiKey?.value,
    authSource: apiKey?.source,
  };
}

function resolveAgentVersion(raw: string | undefined): string {
  if (!raw) return PACKAGE_VERSION;
  if (raw === "auto") {
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .replace(/\.\d{3}Z$/, "");
    return `${PACKAGE_VERSION}+${ts}`;
  }
  return raw;
}

async function resolveApiKey(
  raw: string | SecretRef,
): Promise<{ value: string; source: string }> {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error("weave: apiKey literal is empty");
    return { value: trimmed, source: "literal" };
  }
  if (raw.source === "env") {
    const value = readEnv(raw.id);
    if (!value) throw new Error(`weave: SecretRef env "${raw.id}" is unset or empty`);
    return { value, source: `env:${raw.id}` };
  }
  if (raw.source === "file") {
    const trimmed = (await readFile(raw.id, "utf8")).trim();
    if (!trimmed) throw new Error(`weave: SecretRef file "${raw.id}" is empty`);
    return { value: trimmed, source: `file:${raw.id}` };
  }
  throw new Error(
    `weave: SecretRef source "${raw.source}" is not supported; use "env" or "file"`,
  );
}

