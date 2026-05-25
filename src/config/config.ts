// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { readFile } from "node:fs/promises";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { PACKAGE_VERSION } from "./version.js";

const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const MIN_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_SERVICE_NAME = "openclaw-agent";

/**
 * Granular sub-flags for `captureContent`. Accepted for compatibility with the
 * v1 config shape (and the plugin manifest's configSchema, which still lists
 * them). v2 honors `enabled` only; the per-field flags are recorded so the
 * plugin can warn if someone tries to use them to selectively disable a field.
 */
export type RawCaptureContent = {
  enabled?: boolean;
  inputMessages?: boolean;
  outputMessages?: boolean;
  toolArguments?: boolean;
  toolResults?: boolean;
  systemInstructions?: boolean;
};

export type RawConfig = {
  enabled?: boolean;
  entity?: string;
  project?: string;
  serviceName?: string;
  agentName?: string;
  agentVersion?: string;
  agentDescription?: string;
  captureContent?: boolean | "on" | "off" | RawCaptureContent;
  flushIntervalMs?: number;
  stripSenderWrapper?: boolean;
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
  stripSenderWrapper: boolean;
  apiKey?: string;
  authSource?: string;
};

export async function resolveConfig(raw: RawConfig): Promise<ResolvedConfig> {
  const entity =
    nonEmpty(raw.entity) ??
    nonEmpty(process.env.USER) ??
    nonEmpty(process.env.USERNAME);
  if (!entity) {
    throw new Error(
      "weave: config.entity is required and could not be defaulted ($USER/$USERNAME unset)",
    );
  }
  const project = nonEmpty(raw.project) ?? "openclaw-default";

  const captureContent = resolveCaptureContent(raw.captureContent);

  const apiKey = raw.apiKey ? await resolveApiKey(raw.apiKey) : undefined;

  const flushIntervalMs =
    typeof raw.flushIntervalMs === "number" && Number.isFinite(raw.flushIntervalMs)
      ? Math.max(MIN_FLUSH_INTERVAL_MS, Math.trunc(raw.flushIntervalMs))
      : DEFAULT_FLUSH_INTERVAL_MS;

  return {
    enabled: raw.enabled !== false,
    entity,
    project,
    projectId: `${entity}/${project}`,
    serviceName: nonEmpty(raw.serviceName) ?? DEFAULT_SERVICE_NAME,
    agentName: raw.agentName,
    agentVersion: resolveAgentVersion(raw.agentVersion),
    agentDescription: raw.agentDescription,
    captureContent,
    flushIntervalMs,
    stripSenderWrapper: raw.stripSenderWrapper === true,
    apiKey: apiKey?.value,
    authSource: apiKey?.source,
  };
}

/**
 * Resolve `captureContent` to a single boolean. Defaults to `true` (capture
 * on) so traces are useful out of the box. Accepted shapes:
 *   - `true` / `"on"` / undefined  -> true
 *   - `false` / `"off"`            -> false
 *   - `{ enabled: false, ... }`    -> false (other sub-flags ignored in v2)
 *   - any other object             -> true (treated as "capture on")
 */
function resolveCaptureContent(raw: RawConfig["captureContent"]): boolean {
  if (raw === undefined) return true;
  if (typeof raw === "boolean") return raw;
  if (raw === "off") return false;
  if (raw === "on") return true;
  if (typeof raw === "object" && raw !== null) {
    return raw.enabled !== false;
  }
  return true;
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
    const t = raw.trim();
    if (!t) throw new Error("weave: apiKey literal is empty");
    return { value: t, source: "literal" };
  }
  if (raw.source === "env") {
    const v = process.env[raw.id]?.trim();
    if (!v) throw new Error(`weave: SecretRef env "${raw.id}" is unset or empty`);
    return { value: v, source: `env:${raw.id}` };
  }
  if (raw.source === "file") {
    const t = (await readFile(raw.id, "utf8")).trim();
    if (!t) throw new Error(`weave: SecretRef file "${raw.id}" is empty`);
    return { value: t, source: `file:${raw.id}` };
  }
  throw new Error(
    `weave: SecretRef source "${(raw as SecretRef).source}" is not supported; use "env" or "file"`,
  );
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
