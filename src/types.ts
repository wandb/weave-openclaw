// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";

export type WeaveContentCapture = {
  enabled: boolean;
  inputMessages: boolean;
  outputMessages: boolean;
  toolArguments: boolean;
  toolResults: boolean;
  systemInstructions: boolean;
};

export type RawWeavePluginConfig = {
  enabled?: boolean;
  entity?: string;
  project?: string;
  wandbApiKey?: string | SecretRef;
  /**
   * W&B install base URL (matches the Weave Python SDK's `WANDB_BASE_URL`
   * env var). Defaults to `https://api.wandb.ai` (cloud / MTSaaS). For a
   * dedicated install set this to your install hostname,
   * e.g. `https://acme.wandb.io`. The plugin derives the trace-server URL
   * per the Weave SDK rule (cloud → `https://trace.wandb.ai`; dedicated →
   * `<base>/traces`) and appends `/agents/otel/v1/traces`. Falls back to
   * the `WANDB_BASE_URL` env var when omitted.
   */
  wandbBaseUrl?: string;
  /**
   * Full trace-server URL override (matches the Weave Python SDK's
   * `WF_TRACE_SERVER_URL` env var). Bypasses `wandbBaseUrl` derivation
   * entirely; plugin appends `/agents/otel/v1/traces` and posts there.
   * Use this for self-managed installs or routing through a proxy. Falls
   * back to the `WF_TRACE_SERVER_URL` env var when omitted.
   */
  wfTraceServerUrl?: string;
  serviceName?: string;
  agentName?: string;
  /**
   * Agent version string used as `weave.agent.version`.
   *
   * - Explicit string (e.g. `"v0.1"`) — pin to that value.
   * - `"auto"` — generate fresh `<pkgVersion>+<startupTimestamp>` at service
   *   start so each gateway restart produces a distinct version row in the
   *   Weave Agents tab.
   * - Omit — use the plugin package version as-is.
   */
  agentVersion?: string;
  agentDescription?: string;
  captureContent?: Partial<WeaveContentCapture> & { enabled?: boolean };
  flushIntervalMs?: number;
  /**
   * When true, strip OpenClaw's metadata-wrapper prefix from user-message
   * content before emitting `weave.input.messages`. The wrapper has up to
   * three optional blocks the OpenClaw runtime prepends to user input:
   *
   *     Conversation info (untrusted metadata):
   *     ```json { ... } ```
   *
   *     Sender (untrusted metadata):
   *     ```json { ... } ```
   *     [Sun 2026-05-03 22:11 PDT]
   *     <user's actual text>
   *
   * Applies symmetrically to both `historyMessages` user turns and the
   * in-flight `input.prompt` so a single flag governs all user-message
   * scope.
   *
   * **Default false (raw).** This is the OTel-conforming choice:
   * `gen_ai.input.messages` (and the `weave.input.messages` alias) is by
   * spec "the messages used in the operation" — i.e. what the LLM saw,
   * wrappers included. Every major LLM-observability tool (Phoenix,
   * Helicone, Langfuse, LangSmith, OpenLLMetry) follows the same
   * convention. Keeping raw preserves prompt-injection visibility and
   * wrapper-bug debugging.
   *
   * **Set true** when you'd rather have a clean Weave Agents-tab chat view
   * (the wrapper can be ~500 chars and dwarfs the user's actual question).
   * Trade-off: you lose visibility into anything that lives in the
   * wrapper. The strip is regex-based and best-effort — if OpenClaw
   * changes the wrapper format, the strip silently no-ops and you'll see
   * the wrapper again until the regex is updated.
   */
  stripSenderWrapper?: boolean;
  /**
   * When true, dual-emit OTel-canonical `gen_ai.*` aliases alongside every
   * `weave.*` attribute that has one (per Weave's `_ALIAS_TO_CANONICAL`
   * table; verified against
   * `weave/trace_server/agents/semconv.py`).
   *
   * Default true — improves portability to non-Weave OTel backends
   * (Datadog, Honeycomb, LangSmith, Langfuse) which only recognise the
   * `gen_ai.*` namespace. Cost: ~doubles attribute storage on the producer
   * side per emitted span. The Weave server treats both forms identically
   * via alias resolution, so toggling does not change Weave Agents-tab
   * data quality. Set false to reduce wire size at the cost of portability.
   */
  emitGenAiAliases?: boolean;
};

export type ResolvedWeavePluginConfig = {
  entity: string;
  project: string;
  endpoint: string;
  serviceName: string;
  agentName?: string;
  agentVersion?: string;
  agentDescription?: string;
  captureContent: WeaveContentCapture;
  flushIntervalMs: number;
  stripSenderWrapper: boolean;
  /** Dual-emit `gen_ai.*` aliases alongside `weave.*`. Default true. */
  emitGenAiAliases: boolean;
};

export const NO_CONTENT_CAPTURE: WeaveContentCapture = Object.freeze({
  enabled: false,
  inputMessages: false,
  outputMessages: false,
  toolArguments: false,
  toolResults: false,
  systemInstructions: false,
});

export const FULL_CONTENT_CAPTURE: WeaveContentCapture = Object.freeze({
  enabled: true,
  inputMessages: true,
  outputMessages: true,
  toolArguments: true,
  toolResults: true,
  systemInstructions: true,
});

/**
 * Resolve `captureContent` config to its fully-specified shape.
 *
 * Defaults to FULL capture — the plugin's purpose is to make traces useful
 * in Weave, and empty input/output boxes defeat that. By the time an
 * operator has installed this plugin, set their entity/project, exported
 * `WANDB_API_KEY`, and flipped OpenClaw's `allowConversationAccess: true`
 * hooks gate, they've already consented to the data path multiple times.
 *
 * Operators who need to opt out (compliance, retention policy) explicitly
 * set `captureContent: { enabled: false }` for a hard off, or flip
 * individual sub-flags (`captureContent: { toolResults: false }`) for
 * granular control.
 *
 * Sub-flags default to `true` when `enabled` is true or unset; they only
 * go off when explicitly set to `false`.
 */
export function resolveContentCapture(
  raw: RawWeavePluginConfig["captureContent"],
): WeaveContentCapture {
  if (raw && raw.enabled === false) {
    return NO_CONTENT_CAPTURE;
  }
  if (!raw) {
    return FULL_CONTENT_CAPTURE;
  }
  return {
    enabled: true,
    inputMessages: raw.inputMessages !== false,
    outputMessages: raw.outputMessages !== false,
    toolArguments: raw.toolArguments !== false,
    toolResults: raw.toolResults !== false,
    systemInstructions: raw.systemInstructions !== false,
  };
}
