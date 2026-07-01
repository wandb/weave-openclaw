// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import type { LLM, SubAgent, Tool, Turn } from "weave";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../config/version.js";

// Integration identity stamped on every span so the Weave Agents backend can
// group/filter traces by the emitting integration (a peer to weave-claude-code).
// Fixed per build, unlike the user-overridable gen_ai.agent.name; the non-semconv
// weave.* keys land in the backend's queryable custom-attribute maps.
export const INTEGRATION_ATTRIBUTES: Record<string, string> = {
  "weave.integration.name": PACKAGE_NAME,
  "weave.integration.version": PACKAGE_VERSION,
};

// Stamp the identity on each span directly. The plugin opens every span in its
// own runIsolated() frame, so a Conversation's ambient attributes never reach
// them; per-span stamping lands the identity on the turn and every child alike.
export function stampIntegration<T extends Turn | LLM | Tool | SubAgent>(span: T): T {
  span.setAttributes(INTEGRATION_ATTRIBUTES);
  return span;
}
