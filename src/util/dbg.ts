// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

// DEBUG[weave-msg-trace]: temporary, remove after diagnosis.
// Bypasses console.* because OpenClaw shims stdout into log.record diagnostics,
// which then feed back through the plugin's own diagnostic handler — using
// console.log inside that handler creates an infinite feedback loop.
import { appendFileSync } from "node:fs";

const DBG_FILE = "/tmp/weave-dbg.log";

let _instanceCounter = 0;
export function nextInstanceId(): string {
  _instanceCounter += 1;
  return `i${_instanceCounter}`;
}

export function dbg(msg: string, instanceId?: string): void {
  try {
    const tag = instanceId ? `[${instanceId}] ` : "";
    appendFileSync(DBG_FILE, `${new Date().toISOString()} ${tag}${msg}\n`);
  } catch {
    // ignore
  }
}
