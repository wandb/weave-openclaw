// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { RawWeavePluginConfig } from "./types.js";

const AGENTS_TRACES_PATH = "/agents/otel/v1/traces";
const DEFAULT_BASE_URL = "https://api.wandb.ai";
const MTSAAS_TRACE_URL = "https://trace.wandb.ai";

/**
 * Resolve the full traces endpoint URL the OTLP exporter posts to.
 *
 * Mirrors the W&B Weave Python SDK's URL derivation
 * (`weave/trace/env.py:weave_trace_server_url`) so operators coming from
 * `weave.init(...)` don't have to re-learn the config shape:
 *
 *   1. `wfTraceServerUrl` (config) or `WF_TRACE_SERVER_URL` (env) — full
 *      trace-server URL override. Bypasses base-URL derivation entirely.
 *   2. `wandbBaseUrl` (config) or `WANDB_BASE_URL` (env) — the W&B install
 *      URL, default `https://api.wandb.ai`. When the base is the cloud
 *      default, traces route to the dedicated `https://trace.wandb.ai`
 *      subdomain (MTSaaS). Any other base is treated as a self-managed /
 *      dedicated install and gets `<base>/traces` as its trace-server URL.
 *
 * The plugin appends `/agents/otel/v1/traces` to whatever trace-server URL
 * is resolved.
 *
 * Throws if a supplied override fails minimal validation.
 */
export function resolveWeaveEndpoint(cfg: RawWeavePluginConfig): string {
  return `${resolveTraceServerUrl(cfg)}${AGENTS_TRACES_PATH}`;
}

/**
 * Resolve the W&B app (UI) base URL — the host operators open in a browser to
 * view traces. Derived from `wandbBaseUrl` by stripping a leading `api.`
 * subdomain (cloud convention: api at `api.wandb.ai`, UI at `wandb.ai`).
 * Dedicated installs without an `api.` prefix are returned as-is.
 *
 * `wfTraceServerUrl` intentionally does NOT influence this — it's an ingest
 * override (e.g. a proxy) and tells us nothing about where the UI lives.
 */
export function resolveWeaveAppUrl(cfg: RawWeavePluginConfig): string {
  const baseRaw =
    nonEmpty(cfg.wandbBaseUrl) ??
    nonEmpty(process.env.WANDB_BASE_URL) ??
    DEFAULT_BASE_URL;
  const base = normalizeAndValidateUrl(baseRaw, "wandbBaseUrl");
  return base.replace(/^(https?:\/\/)api\./i, "$1");
}

function resolveTraceServerUrl(cfg: RawWeavePluginConfig): string {
  const wfOverride =
    nonEmpty(cfg.wfTraceServerUrl) ?? nonEmpty(process.env.WF_TRACE_SERVER_URL);
  if (wfOverride !== undefined) {
    return normalizeAndValidateUrl(wfOverride, "wfTraceServerUrl");
  }

  const baseRaw =
    nonEmpty(cfg.wandbBaseUrl) ??
    nonEmpty(process.env.WANDB_BASE_URL) ??
    DEFAULT_BASE_URL;
  const base = normalizeAndValidateUrl(baseRaw, "wandbBaseUrl");

  if (base === DEFAULT_BASE_URL) {
    return MTSAAS_TRACE_URL;
  }
  return `${base}/traces`;
}

/**
 * Strip trailing slashes; check the URL has a protocol prefix; reject the
 * common mistake of including the agents-traces path in a trace-server URL.
 */
function normalizeAndValidateUrl(raw: string, fieldName: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      `weave.${fieldName} must start with http:// or https:// (got: ${raw})`,
    );
  }
  if (trimmed.endsWith(AGENTS_TRACES_PATH)) {
    throw new Error(
      `weave.${fieldName} is the trace-server URL (e.g. "https://trace.wandb.ai" for cloud or "https://acme.wandb.io" for dedicated), NOT the full agents endpoint. Drop the trailing "${AGENTS_TRACES_PATH}".`,
    );
  }
  return trimmed;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
