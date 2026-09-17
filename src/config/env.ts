// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { homedir } from "node:os";
import { join } from "node:path";
import { Netrc } from "netrc-parser";

// All process.env reads; functions, not constants, so tests can stub between resolves.
// apiKey SecretRefs (env/file/exec) are resolved by OpenClaw's secret providers, not here.
export function readWandbBaseUrl(): string | undefined {
  return process.env.WANDB_BASE_URL?.trim();
}

export async function readDefaultApiKey(): Promise<{ value: string; source: string } | undefined> {
  const apiKey = process.env.WANDB_API_KEY;
  if (apiKey) return { value: apiKey, source: "WANDB_API_KEY env" };
  const host = new URL(readWandbBaseUrl() || "https://api.wandb.ai").host;
  const netrc = new Netrc(join(homedir(), ".netrc"));
  await netrc.load();
  const value = netrc.machines[host]?.password;
  return value ? { value, source: "~/.netrc" } : undefined;
}
