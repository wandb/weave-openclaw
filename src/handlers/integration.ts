// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { PACKAGE_NAME, PACKAGE_VERSION } from "../config/version.js";

// Integration identity propagated to every span so the Weave Agents backend can
// group/filter traces by the emitting integration (a peer to weave-claude-code).
// Fixed per build, unlike the user-overridable gen_ai.agent.name; the non-semconv
// weave.* keys land in the backend's queryable custom-attribute maps.
//
// Set once at each trace's root: on the Conversation (startConversation), or on
// the Turn (startTurn) for a rootless run. The weave SDK then propagates it down
// the handle chain to every child span (chat, tool, subagent).
export const INTEGRATION_ATTRIBUTES: Record<string, string> = {
  "weave.integration.name": PACKAGE_NAME,
  "weave.integration.version": PACKAGE_VERSION,
};
