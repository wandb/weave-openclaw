// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

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
  modelUsage,
  assistantMessage,
} from "./test/helpers.js";

// Stub weave.login so the smoke doesn't hit the live server or write ~/.netrc.
vi.mock("weave", async (importOriginal) => {
  const actual = await importOriginal<typeof import("weave")>();
  return { ...actual, login: vi.fn().mockResolvedValue(undefined) };
});

const exporter = pinInMemoryExporter();

describe("end-to-end smoke", () => {
  it("emits a clean trace for a session + run + chat + tool sequence", async () => {
    const { dispatch, finish } = await bootPlugin({ captureContent: true, agentName: "test-agent" });

    dispatch.hook("session_start", { sessionKey: "s-1" });
    runStarted(dispatch, { runId: "r-1", sessionKey: "s-1" });
    dispatch.hook("model_call_started", { runId: "r-1", callId: "c-1" });
    modelCallStarted(dispatch, { runId: "r-1", callId: "c-1", spanId: "csp" });
    dispatch.hook("llm_input", { runId: "r-1", prompt: "hi", systemPrompt: "be helpful" });
    dispatch.hook("before_tool_call", { runId: "r-1", toolCallId: "tc-1", toolName: "search", params: { q: "weave" } });
    toolStarted(dispatch, { runId: "r-1", toolCallId: "tc-1", spanId: "tcsp", parentSpanId: "csp" });
    dispatch.hook("after_tool_call", { runId: "r-1", toolCallId: "tc-1", result: { hits: 7 } });
    toolCompleted(dispatch, { runId: "r-1", toolCallId: "tc-1", spanId: "tcsp" });
    assistantMessage(dispatch, { sessionKey: "s-1", text: "found 7", usage: { input: 5, output: 3 } });
    modelCallCompleted(dispatch, { runId: "r-1", callId: "c-1", spanId: "csp" });
    modelUsage(dispatch, { runId: "r-1", costUsd: 0.0001 });
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

    expect(chat.attributes).toMatchInlineSnapshot(`
      {
        "gen_ai.conversation.id": "s-1",
        "gen_ai.input.messages": "[{"role":"system","content":"be helpful"},{"role":"user","content":"hi"}]",
        "gen_ai.operation.name": "chat",
        "gen_ai.output.messages": "[{"role":"assistant","content":"found 7"}]",
        "gen_ai.request.model": "gpt-4o",
        "gen_ai.usage.input_tokens": 5,
        "gen_ai.usage.output_tokens": 3,
        "weave.integration.name": "weave-openclaw",
        "weave.integration.version": "0.1.1",
      }
    `);
    expect(tool.attributes).toMatchInlineSnapshot(`
      {
        "gen_ai.conversation.id": "s-1",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.call.arguments": "{"q":"weave"}",
        "gen_ai.tool.call.id": "tc-1",
        "gen_ai.tool.call.result": "{"hits":7}",
        "gen_ai.tool.name": "search",
        "weave.integration.name": "weave-openclaw",
        "weave.integration.version": "0.1.1",
      }
    `);
    // weave.agent.version is the package version (asserted by value in
    // plugin.test.ts); here just confirm it's stamped, so a version bump never
    // churns this end-to-end snapshot.
    expect(turn.attributes).toHaveProperty("weave.agent.version");
    const turnAttrs: Record<string, unknown> = { ...turn.attributes };
    delete turnAttrs["weave.agent.version"];
    expect(turnAttrs).toMatchInlineSnapshot(`
      {
        "gen_ai.agent.name": "test-agent",
        "gen_ai.conversation.id": "s-1",
        "gen_ai.operation.name": "invoke_agent",
        "weave.cost.usd": 0.0001,
        "weave.integration.name": "weave-openclaw",
        "weave.integration.version": "0.1.1",
        "weave.outcome": "completed",
      }
    `);
  });

  // Real attempt shape: one llm_input, then model -> tool -> model. Each model
  // call's output rides in on its own before_message_write; each gets its own chat span.
  it("multi-model-call attempt: both chat spans get their content", async () => {
    const { dispatch, finish } = await bootPlugin({ captureContent: true, agentName: "test-agent" });

    dispatch.hook("session_start", { sessionKey: "s-2" });
    runStarted(dispatch, { runId: "r-2", sessionKey: "s-2", trace: { traceId: "tt", spanId: "sp2" } });
    dispatch.hook("llm_input", { runId: "r-2", prompt: "find tennis stats", systemPrompt: "be brief" });
    dispatch.hook("model_call_started", { runId: "r-2", callId: "c-A" });
    modelCallStarted(dispatch, { runId: "r-2", callId: "c-A", spanId: "csp-A", parentSpanId: "sp2", traceId: "tt" });
    assistantMessage(dispatch, { sessionKey: "s-2", text: "I'll search" });
    modelCallCompleted(dispatch, { runId: "r-2", callId: "c-A", spanId: "csp-A", traceId: "tt" });
    dispatch.hook("before_tool_call", { runId: "r-2", toolCallId: "tc-A", toolName: "search", params: { q: "tennis" } });
    toolStarted(dispatch, { runId: "r-2", toolCallId: "tc-A", spanId: "tsp-A", parentSpanId: "sp2", traceId: "tt" });
    dispatch.hook("after_tool_call", { runId: "r-2", toolCallId: "tc-A", result: { hits: 3 } });
    toolCompleted(dispatch, { runId: "r-2", toolCallId: "tc-A", spanId: "tsp-A", traceId: "tt" });
    dispatch.hook("model_call_started", { runId: "r-2", callId: "c-B" });
    modelCallStarted(dispatch, { runId: "r-2", callId: "c-B", spanId: "csp-B", parentSpanId: "sp2", traceId: "tt" });
    assistantMessage(dispatch, { sessionKey: "s-2", text: "Found 3 results", usage: { input: 12, output: 8 } });
    modelCallCompleted(dispatch, { runId: "r-2", callId: "c-B", spanId: "csp-B", traceId: "tt" });
    runCompleted(dispatch, { runId: "r-2", sessionKey: "s-2", trace: { traceId: "tt", spanId: "sp2" } });
    dispatch.hook("session_end", { sessionKey: "s-2" });
    await finish();

    const chats = exporter.getFinishedSpans().filter(s => s.name === "chat");
    expect(chats.map(s => s.attributes)).toMatchInlineSnapshot(`
      [
        {
          "gen_ai.conversation.id": "s-2",
          "gen_ai.input.messages": "[{"role":"system","content":"be brief"},{"role":"user","content":"find tennis stats"}]",
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": "[{"role":"assistant","content":"I'll search"}]",
          "gen_ai.request.model": "gpt-4o",
          "weave.integration.name": "weave-openclaw",
          "weave.integration.version": "0.1.1",
        },
        {
          "gen_ai.conversation.id": "s-2",
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": "[{"role":"assistant","content":"Found 3 results"}]",
          "gen_ai.request.model": "gpt-4o",
          "gen_ai.usage.input_tokens": 12,
          "gen_ai.usage.output_tokens": 8,
          "weave.integration.name": "weave-openclaw",
          "weave.integration.version": "0.1.1",
        },
      ]
    `);
  });
});
