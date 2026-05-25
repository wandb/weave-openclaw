// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { Turn } from "weave";

export function safeJson(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

export function setIfInt(turn: Turn | undefined, key: string, v: unknown): void {
  if (!turn) return;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
    turn.setAttribute(key, Math.trunc(v));
  }
}
