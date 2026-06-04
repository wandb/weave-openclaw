// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { Turn } from "weave";

// Serialize a captured value for a span attribute; strings pass through.
export function safeJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// Stamp a non-negative integer count onto the Turn, skipping absent/invalid values.
export function setIfInt(turn: Turn | undefined, key: string, value: unknown): void {
  if (!turn) return;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    turn.setAttribute(key, Math.trunc(value));
  }
}

// gen_ai.usage.input_tokens is the TOTAL prompt. OpenClaw normalizes `input` to
// uncached-only (cache_read/cache_creation a disjoint subset across providers), so sum
// the three (keeps cache_read / input_tokens <= 100% downstream). Ref: weave-claude-code#68.
export function totalPromptTokens(
  input?: number,
  cacheRead?: number,
  cacheWrite?: number,
): number | undefined {
  if (input === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined;
  }
  return (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
}
