// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { createHash } from "node:crypto";

/**
 * Deterministic 8-char hex hash of (entity, project, harnessId) — produces a
 * stable `weave.agent.id` that's invariant under display-name changes. Weave's
 * Agents tab dedupes by `weave.agent.id`, so renaming the agent shouldn't
 * fork its history in the Versions panel.
 *
 * Falls back to "unknown" when no harness/agent identifier is supplied so we
 * never emit a partial / null id.
 */
export function stableAgentId(
  entity: string,
  project: string,
  harnessId: string | undefined,
): string {
  const h = harnessId && harnessId.length > 0 ? harnessId : "unknown";
  const hash = createHash("sha256").update(`${entity}/${project}/${h}`).digest("hex");
  return hash.slice(0, 8);
}
