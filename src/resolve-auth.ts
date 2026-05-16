// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { readFile } from "node:fs/promises";
import { coerceSecretRef, type SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";

const ENV_FALLBACK_KEY = "WANDB_API_KEY";

export type ResolvedWandbAuth = {
  key: string;
  /**
   * Human-readable source identifier for logging. Never contains the key.
   * Shape: "env:<VAR>" | "file:<PATH>" | "literal".
   */
  source: string;
};

/**
 * Resolve the W&B API key from one of these sources:
 *
 * 1. SecretRef shape `{ source, provider, id }`:
 *    - `source: "env"` — `process.env[id]`
 *    - `source: "file"` — read from path at `id` and trim
 *    - `source: "exec"` — not supported yet
 * 2. Plain string in config (discouraged for production).
 * 3. `process.env.WANDB_API_KEY` if `apiKey` is undefined.
 *
 * Returns `{ key, source }` where `source` is safe to log.
 *
 * Throws when no key is found. The error never includes the key value.
 */
export async function resolveWandbApiKey(
  apiKey: string | SecretRef | undefined,
): Promise<ResolvedWandbAuth> {
  const ref = coerceSecretRef(apiKey);
  if (ref) {
    return await resolveSecretRef(ref);
  }
  if (typeof apiKey === "string") {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) {
      throw new Error("weave.apiKey is empty");
    }
    return { key: trimmed, source: "literal" };
  }
  const fromEnv = process.env[ENV_FALLBACK_KEY]?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return { key: fromEnv, source: `env:${ENV_FALLBACK_KEY}` };
  }
  throw new Error(
    `weave: no API key configured. Set weave.apiKey in plugin config or export ${ENV_FALLBACK_KEY}.`,
  );
}

async function resolveSecretRef(ref: SecretRef): Promise<ResolvedWandbAuth> {
  if (ref.source === "env") {
    const value = process.env[ref.id]?.trim();
    if (!value || value.length === 0) {
      throw new Error(`weave: SecretRef env var "${ref.id}" is unset or empty.`);
    }
    return { key: value, source: `env:${ref.id}` };
  }
  if (ref.source === "file") {
    let raw: string;
    try {
      raw = await readFile(ref.id, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      throw new Error(
        `weave: SecretRef file "${ref.id}" could not be read${code ? ` (${code})` : ""}.`,
      );
    }
    const value = raw.trim();
    if (value.length === 0) {
      throw new Error(`weave: SecretRef file "${ref.id}" is empty.`);
    }
    return { key: value, source: `file:${ref.id}` };
  }
  throw new Error(
    `weave: SecretRef source "${ref.source}" is not supported by this plugin yet. Use "env" or "file".`,
  );
}
