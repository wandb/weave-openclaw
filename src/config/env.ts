// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

/**
 * Every `process.env` read in this plugin goes through this module.
 *
 * Centralizing the env surface lets a reader see the full set of environment
 * variables the plugin touches in one file, and gives tests a single boundary
 * to stub. The Weave Node SDK reads `WANDB_API_KEY`, `WANDB_BASE_URL`, and
 * `~/.netrc` on its own; when the operator supplies an apiKey via plugin
 * config, the plugin hands it to the SDK's `login()` which owns the env stamp
 * and any netrc write.
 *
 * Accessors are functions (not exported constants) so tests that mutate
 * `process.env` between resolves see the updated values.
 */

/** W&B API host. Unset for the public cloud default; dedicated installs override. */
export function readWandbBaseUrl(): string | undefined {
  return process.env.WANDB_BASE_URL?.trim();
}

/** POSIX shell user. Used as a fallback default for `config.entity`. */
export function readPosixUser(): string | undefined {
  return process.env.USER;
}

/** Windows shell user. Used as a fallback default for `config.entity`. */
export function readWindowsUser(): string | undefined {
  return process.env.USERNAME;
}

/**
 * Read an operator-named env var supplied via SecretRef `{ source: "env", id }`.
 * The variable name is dynamic, so this is the one accessor without a static
 * counterpart above. Returns trimmed-or-undefined so the resolver can treat
 * whitespace-only values as missing.
 */
export function readSecretEnv(name: string): string | undefined {
  return process.env[name]?.trim();
}
