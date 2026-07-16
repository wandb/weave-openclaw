// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

// Integration identity must ride onto EVERY span in a trace, not just the
// invoke_agent root, so the Weave Agents backend can group/filter a chat or
// execute_tool span by integration just like the turn. The plugin sets it once
// at each trace's root (on the Conversation, or on a rootless Turn), and the
// weave SDK propagates it down the handle chain to every child span. This holds
// even though each span opens in its own runIsolated frame: the attributes ride
// the stored Conversation/Turn handle, not ambient state. The literal wire keys
// are the contract the backend reads into its queryable custom-attribute maps.

import { describe, it, expect, vi, assert } from "vitest";
import {
  bootPlugin,
  pinInMemoryExporter,
  runStarted,
  runCompleted,
  modelCallStarted,
  modelCallCompleted,
  toolStarted,
  toolCompleted,
} from "./test/helpers.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./config/version.js";

vi.mock("weave", async (importOriginal) => {
  const actual = await importOriginal<typeof import("weave")>();
  return { ...actual, login: vi.fn().mockResolvedValue(undefined) };
});

const exporter = pinInMemoryExporter();

describe("integration attribution", () => {
  it("propagates weave.integration.* to every span under a session (turn, chat, tool)", async () => {
    const { dispatch, finish } = await bootPlugin({ agentName: "test-agent" });

    dispatch.hook("session_start", { sessionKey: "s-1" });
    runStarted(dispatch, { runId: "r-1", sessionKey: "s-1" });
    modelCallStarted(dispatch, { runId: "r-1", callId: "c-1", spanId: "csp" });
    toolStarted(dispatch, { runId: "r-1", toolCallId: "tc-1", spanId: "tcsp", parentSpanId: "csp" });
    toolCompleted(dispatch, { runId: "r-1", toolCallId: "tc-1", spanId: "tcsp" });
    modelCallCompleted(dispatch, { runId: "r-1", callId: "c-1", spanId: "csp" });
    runCompleted(dispatch, { runId: "r-1", sessionKey: "s-1" });
    dispatch.hook("session_end", { sessionKey: "s-1" });
    await finish();

    const spans = exporter.getFinishedSpans();
    const turn = spans.find(s => s.name === "invoke_agent");
    const chat = spans.find(s => s.name === "chat");
    const tool = spans.find(s => s.name === "execute_tool");
    assert(turn);
    assert(chat);
    assert(tool);

    for (const span of [turn, chat, tool]) {
      expect(span.attributes["weave.integration.name"]).toBe(PACKAGE_NAME);
      expect(span.attributes["weave.integration.version"]).toBe(PACKAGE_VERSION);
    }
  });

  it("propagates to every span on the sessionless fallback (no sessionKey), children included", async () => {
    const { dispatch, finish } = await bootPlugin({ agentName: "test-agent" });

    // run.started with no sessionKey: getOrCreateConversation returns undefined,
    // so the handler opens a rootless Turn carrying INTEGRATION_ATTRIBUTES, which
    // the SDK propagates to the chat and tool spans nested under that Turn.
    dispatch.diagnostic({ type: "run.started", ts: 1000, runId: "r-x", trace: { traceId: "t", spanId: "sp" } });
    modelCallStarted(dispatch, { runId: "r-x", callId: "c-x", spanId: "csp" });
    toolStarted(dispatch, { runId: "r-x", toolCallId: "tc-x", spanId: "tcsp", parentSpanId: "csp" });
    toolCompleted(dispatch, { runId: "r-x", toolCallId: "tc-x", spanId: "tcsp" });
    modelCallCompleted(dispatch, { runId: "r-x", callId: "c-x", spanId: "csp" });
    dispatch.diagnostic({ type: "run.completed", ts: 2000, runId: "r-x", outcome: "completed", trace: { traceId: "t", spanId: "sp" } });
    await finish();

    const spans = exporter.getFinishedSpans();
    const turn = spans.find(s => s.name === "invoke_agent");
    const chat = spans.find(s => s.name === "chat");
    const tool = spans.find(s => s.name === "execute_tool");
    assert(turn);
    assert(chat);
    assert(tool);

    for (const span of [turn, chat, tool]) {
      expect(span.attributes["weave.integration.name"]).toBe(PACKAGE_NAME);
      expect(span.attributes["weave.integration.version"]).toBe(PACKAGE_VERSION);
    }
  });
});
