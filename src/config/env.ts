// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

// All process.env reads; functions, not constants, so tests can stub between resolves.
// apiKey SecretRefs (env/file/exec) are resolved by OpenClaw's secret providers, not here.
export function readWandbBaseUrl(): string | undefined {
  return process.env.WANDB_BASE_URL?.trim();
}
