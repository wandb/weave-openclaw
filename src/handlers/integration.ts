// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { LLM, SubAgent, Tool, Turn } from "weave";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../config/version.js";

// Integration identity propagated to every span so the Weave Agents backend can
// group/filter traces by the emitting integration (a peer to weave-claude-code).
// Fixed per build, unlike the user-overridable gen_ai.agent.name; the non-semconv
// weave.* keys land in the backend's queryable custom-attribute maps.
export const INTEGRATION_ATTRIBUTES: Record<string, string> = {
  "weave.integration.name": PACKAGE_NAME,
  "weave.integration.version": PACKAGE_VERSION,
};

// Propagate the identity to every span in a turn's subtree. Weave's own vehicle
// for this (a Conversation's ambient attributes) can't reach these spans, since
// each opens in its own runIsolated() frame; applying it at every creation site
// propagates it to the turn and each child alike.
export function propagateIntegration<T extends Turn | LLM | Tool | SubAgent>(span: T): T {
  span.setAttributes(INTEGRATION_ATTRIBUTES);
  return span;
}
