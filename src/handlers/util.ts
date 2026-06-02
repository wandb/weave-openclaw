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
