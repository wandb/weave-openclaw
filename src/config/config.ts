// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { PACKAGE_VERSION } from "./version.js";

const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const MIN_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_SERVICE_NAME = "openclaw-agent";
const API_KEY_CONFIG_PATH = "plugins.entries.weave.config.apiKey";

// Raw plugin settings from openclaw.plugin.json. `entity` and `project` are required (resolveConfig
// throws when either is unset/empty); projectId is always `entity/project`. resolveConfig() applies
// defaults for the rest.
export type RawConfig = {
  enabled?: boolean;
  entity: string;
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
  entity: string;
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

// Resolution dependencies from the plugin service start context (ctx.config), needed so SecretRef
// apiKeys go through OpenClaw's configured secret providers instead of being read by hand.
export type ResolveContext = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

export async function resolveConfig(raw: RawConfig, ctx: ResolveContext): Promise<ResolvedConfig> {
  const entity = raw.entity?.trim();
  if (!entity) throw new Error("weave: entity is required; set it in the plugin config");
  const project = raw.project?.trim();
  if (!project) throw new Error("weave: project is required; set it in the plugin config");

  const apiKey = raw.apiKey ? await resolveApiKey(raw.apiKey, ctx) : undefined;

  const flushIntervalMs = Math.max(
    MIN_FLUSH_INTERVAL_MS,
    raw.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
  );

  return {
    enabled: raw.enabled !== false,
    entity,
    project,
    projectId: `${entity}/${project}`,
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

// Resolve a literal or SecretRef apiKey via OpenClaw's secret resolver, which reads env/file/exec
// through the operator's configured `secrets.providers` (env "default" works with no config; file
// and exec require a configured provider). authSource is derived from the raw shape for /weave status.
async function resolveApiKey(
  raw: string | SecretRef,
  ctx: ResolveContext,
): Promise<{ value: string; source: string }> {
  const resolved = await resolveConfiguredSecretInputString({
    config: ctx.config,
    env: ctx.env ?? process.env,
    value: raw,
    path: API_KEY_CONFIG_PATH,
    unresolvedReasonStyle: "detailed",
  });
  if (!resolved.value) {
    throw new Error(`weave: ${resolved.unresolvedRefReason ?? "apiKey resolved to an empty value"}`);
  }
  return {
    value: resolved.value,
    source: typeof raw === "string" ? "literal" : `${raw.source}:${raw.id}`,
  };
}

