// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { Turn } from "weave";

export function safeJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function setIfInt(turn: Turn | undefined, key: string, value: unknown): void {
  if (!turn) return;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    turn.setAttribute(key, Math.trunc(value));
  }
}
