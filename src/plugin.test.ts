// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect, afterEach, vi, assert } from "vitest";
import { createWeaveHookState } from "./state/hook-state.js";
import {
  bootPlugin,
  makeLogger,
  pinInMemoryExporter,
  setupTurn,
  TRACE,
  runStarted,
  runCompleted,
  modelCallStarted,
  modelCallCompleted,
  modelCallError,
  toolStarted,
  toolCompleted,
  toolError,
  toolBlocked,
  modelUsage,
} from "./test/helpers.js";

// Stub weave.login so tests don't hit the live server or write ~/.netrc.
vi.mock("weave", async (importOriginal) => {
  const actual = await importOriginal<typeof import("weave")>();
  return { ...actual, login: vi.fn().mockResolvedValue(undefined) };
});

const exporter = pinInMemoryExporter();

describe("createWeavePlugin lifecycle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts running and exposes a config snapshot, then stops", async () => {
    const { createWeavePlugin } = await import("./plugin.js");
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "my-team", project: "my-project", apiKey: "k", serviceName: "openclaw-agent" },
      hookState: createWeaveHookState(),
    });
    await plugin.service.start({ logger: makeLogger(), config: {} } as any);
    const status = plugin.getStatus();
    expect(status.lifecycle).toBe("running");
    assert(status.config);
    expect(status.config.projectId).toBe("my-team/my-project");
    expect(status.config.serviceName).toBe("openclaw-agent");
    expect(status.config.authSource).toBe("literal");
    expect(status.counts).toEqual({ turns: 0, calls: 0, tools: 0, subagents: 0 });

    await plugin.service.stop({ logger: makeLogger() } as any);
    expect(plugin.getStatus().lifecycle).toBe("stopped");
  });

  it("stays out of running when disabled or when config resolution fails", async () => {
    const { createWeavePlugin } = await import("./plugin.js");

    const disabledLog = makeLogger();
    const disabled = createWeavePlugin({
      pluginConfig: { enabled: false, entity: "my-team", project: "my-project" },
      hookState: createWeaveHookState(),
    });
    await disabled.service.start({ logger: disabledLog, config: {} } as any);
    expect(disabled.getStatus().lifecycle).toBe("disabled");
    expect(disabledLog.warn).toHaveBeenCalled();

    const errorLog = makeLogger();
    const errored = createWeavePlugin({
      pluginConfig: {
        entity: "my-team",
        project: "my-project",
        apiKey: { source: "file", id: "/tmp/weave-missing-key-" + Date.now(), provider: "x" },
      },
      hookState: createWeaveHookState(),
    });
    await errored.service.start({ logger: errorLog, config: {} } as any);
    expect(errored.getStatus().lifecycle).toBe("config-error");
    expect(errorLog.error).toHaveBeenCalled();
  });
});

describe("turn lifecycle", () => {
  it("opens the invoke_agent Turn on run.started and ends it (with a default agent name) on run.completed", async () => {
    const { plugin, dispatch, finish } = await bootPlugin(); // no explicit agentName
    runStarted(dispatch, { runId: "r-1" });
    expect(plugin.registries.turns.has("r-1")).toBe(true);
    runCompleted(dispatch, { runId: "r-1" });
    await finish();
    expect(plugin.registries.turns.has("r-1")).toBe(false);
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    assert(turn);
    expect(turn.attributes).toMatchInlineSnapshot(`
      {
        "gen_ai.agent.name": "openclaw-agent",
        "gen_ai.conversation.id": "s",
        "gen_ai.operation.name": "invoke_agent",
        "weave.agent.version": "0.1.0",
        "weave.outcome": "completed",
      }
    `);
  });

  it("maps outcome to span status: aborted stays OK, error marks ERROR (weave.outcome stamped)", async () => {
    const { dispatch, finish } = await bootPlugin();
    runStarted(dispatch, { runId: "r-ok", sessionKey: "s-ok" });
    runCompleted(dispatch, { runId: "r-ok", outcome: "aborted", sessionKey: "s-ok" });
    runStarted(dispatch, { runId: "r-bad", sessionKey: "s-bad" });
    runCompleted(dispatch, { runId: "r-bad", outcome: "error", sessionKey: "s-bad" });
    await finish();
    const spans = exporter.getFinishedSpans().filter(s => s.name === "invoke_agent");
    const aborted = spans.find(s => s.attributes["weave.outcome"] === "aborted");
    const errored = spans.find(s => s.attributes["weave.outcome"] === "error");
    assert(aborted);
    assert(errored);
    expect(aborted.status.code).not.toBe(2); // user-cancel must not count as error
    expect(errored.status.code).toBe(2);
  });

  it("opens a Session on session_start, wraps the run's Turn, and closes on session_end", async () => {
    const { plugin, dispatch, finish } = await bootPlugin();
    dispatch.hook("session_start", { sessionKey: "s-1" });
    expect(plugin.registries.sessions.has("s-1")).toBe(true);
    runStarted(dispatch, { runId: "r-1", sessionKey: "s-1" });
    runCompleted(dispatch, { runId: "r-1", sessionKey: "s-1" });
    dispatch.hook("session_end", { sessionKey: "s-1" });
    expect(plugin.registries.sessions.has("s-1")).toBe(false);
    await finish();
    // The Session surfaces only as gen_ai.conversation.id on the Turns it wraps; it
    // never exports a standalone span, so the run's Turn is the only span emitted.
    const spans = exporter.getFinishedSpans();
    expect(spans.map(s => s.name)).toMatchInlineSnapshot(`
      [
        "invoke_agent",
      ]
    `);
    expect(spans[0].attributes["gen_ai.conversation.id"]).toBe("s-1");
  });

  it("agent_end stamps success/duration (omits success when absent, honors false)", async () => {
    const { dispatch, finish } = await bootPlugin();
    runStarted(dispatch, { runId: "r-yes" });
    dispatch.hook("agent_end", { runId: "r-yes", success: true, durationMs: 1500 });
    runCompleted(dispatch, { runId: "r-yes" });
    runStarted(dispatch, { runId: "r-absent" });
    dispatch.hook("agent_end", { runId: "r-absent", durationMs: 100 });
    runCompleted(dispatch, { runId: "r-absent" });
    runStarted(dispatch, { runId: "r-false" });
    dispatch.hook("agent_end", { runId: "r-false", success: false });
    runCompleted(dispatch, { runId: "r-false" });
    await finish();
    const spans = exporter.getFinishedSpans().filter(s => s.name === "invoke_agent");
    expect(spans).toHaveLength(3);
    expect(spans[0].attributes).toMatchInlineSnapshot(`
      {
        "gen_ai.agent.name": "openclaw-agent",
        "gen_ai.conversation.id": "s",
        "gen_ai.operation.name": "invoke_agent",
        "weave.agent.duration_ms": 1500,
        "weave.agent.success": true,
        "weave.agent.version": "0.1.0",
        "weave.outcome": "completed",
      }
    `);
    expect(spans[1].attributes).toMatchInlineSnapshot(`
      {
        "gen_ai.agent.name": "openclaw-agent",
        "gen_ai.conversation.id": "s",
        "gen_ai.operation.name": "invoke_agent",
        "weave.agent.duration_ms": 100,
        "weave.agent.version": "0.1.0",
        "weave.outcome": "completed",
      }
    `);
    expect(spans[2].attributes).toMatchInlineSnapshot(`
      {
        "gen_ai.agent.name": "openclaw-agent",
        "gen_ai.conversation.id": "s",
        "gen_ai.operation.name": "invoke_agent",
        "weave.agent.success": false,
        "weave.agent.version": "0.1.0",
        "weave.outcome": "completed",
      }
    `);
  });
});

describe("llm two-signal close", () => {
  it("buffers llm_input before model_call_started, promotes it, and closes the chat span with model + usage", async () => {
    const { dispatch, hookState, finish } = await setupTurn();
    dispatch.hook("llm_input", { runId: "r", prompt: "hi", systemPrompt: "be helpful" });
    expect(hookState.pendingLlmInputByRun.has("r")).toBe(true);
    dispatch.hook("model_call_started", { runId: "r", callId: "c-1" });
    expect(hookState.pendingLlmInputByRun.has("r")).toBe(false);
    expect(hookState.llmInputs.has("c-1")).toBe(true);
    modelCallStarted(dispatch, { callId: "c-1", spanId: "sp2" });
    dispatch.hook("llm_output", { runId: "r", assistantTexts: ["hello"], usage: { input: 5, output: 3 } });
    modelCallCompleted(dispatch, { callId: "c-1", spanId: "sp2" });
    runCompleted(dispatch);
    await finish();
    const chat = exporter.getFinishedSpans().find(s => s.name === "chat");
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    assert(chat);
    assert(turn);
    // chat span nests under the invoke_agent Turn
    expect(chat.parentSpanId).toBe(turn.spanContext().spanId);
    // full emitted payload: model, conversation, captured input/output messages, usage
    expect(chat.attributes).toMatchInlineSnapshot(`
      {
        "gen_ai.conversation.id": "s",
        "gen_ai.input.messages": "[{"role":"system","content":"be helpful"},{"role":"user","content":"hi"}]",
        "gen_ai.operation.name": "chat",
        "gen_ai.output.messages": "[{"role":"assistant","content":"hello"}]",
        "gen_ai.request.model": "gpt-4o",
        "gen_ai.usage.input_tokens": 5,
        "gen_ai.usage.output_tokens": 3,
      }
    `);
  });

  it("marks the chat span ERROR on model.call.error", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("model_call_started", { runId: "r", callId: "c-1" });
    modelCallStarted(dispatch, { callId: "c-1", spanId: "sp2" });
    modelCallError(dispatch, { callId: "c-1", spanId: "sp2", errorCategory: "ProviderTimeout" });
    runCompleted(dispatch);
    await finish();
    const chat = exporter.getFinishedSpans().find(s => s.name === "chat");
    assert(chat);
    expect(chat.status.code).toBe(2);
  });
});

describe("closeRunChatSpans positional attribution", () => {
  async function twoCallRun(texts: string[]) {
    const { dispatch, finish } = await bootPlugin();
    runStarted(dispatch);
    for (const callId of ["c-1", "c-2"]) {
      dispatch.hook("model_call_started", { runId: "r", callId });
      modelCallStarted(dispatch, { callId, spanId: callId });
      modelCallCompleted(dispatch, { callId, spanId: callId });
    }
    dispatch.hook("llm_output", { runId: "r", assistantTexts: texts });
    runCompleted(dispatch);
    await finish();
    return exporter.getFinishedSpans().filter(s => s.name === "chat").map(s => String(s.attributes["gen_ai.output.messages"] ?? ""));
  }

  it("folds surplus texts into the last span and pads scarcity from the last text", async () => {
    const surplus = await twoCallRun(["call-1-text", "call-2-text", "trailing-overflow"]);
    expect(surplus.length).toBe(2);
    expect(surplus[0]).toContain("call-1-text");
    expect(surplus[0]).not.toContain("trailing-overflow");
    expect(surplus[1]).toContain("call-2-text");
    expect(surplus[1]).toContain("trailing-overflow");

    exporter.reset();
    const scarcity = await twoCallRun(["only-text"]);
    expect(scarcity.length).toBe(2);
    expect(scarcity[0]).toContain("only-text");
    expect(scarcity[1]).toContain("only-text");
  });

  it("warns when llm_output text count drifts from the tracked chat-span count", async () => {
    const { dispatch, finish, logger } = await bootPlugin();
    runStarted(dispatch);
    dispatch.hook("model_call_started", { runId: "r", callId: "c-1" });
    modelCallStarted(dispatch, { callId: "c-1", spanId: "cs1" });
    modelCallCompleted(dispatch, { callId: "c-1", spanId: "cs1" });
    dispatch.hook("llm_output", { runId: "r", assistantTexts: ["a", "b"] }); // 2 texts, 1 tracked span
    runCompleted(dispatch);
    await finish();
    const warned = (logger.warn as any).mock.calls.map((c: any[]) => String(c[0])).some((m: string) => m.includes("did not match tracked chat-span count"));
    expect(warned).toBe(true);
  });
});

describe("tool lifecycle", () => {
  it("opens execute_tool spans (stamping captured args/result) and marks error + blocked as ERROR", async () => {
    const { dispatch, finish } = await setupTurn();
    // completed, with captured args + result
    dispatch.hook("before_tool_call", { runId: "r", toolCallId: "tc-1", toolName: "search", params: { q: "weave" } });
    toolStarted(dispatch, { toolCallId: "tc-1", spanId: "tc1" });
    dispatch.hook("after_tool_call", { runId: "r", toolCallId: "tc-1", result: { hits: 7 } });
    toolCompleted(dispatch, { toolCallId: "tc-1", spanId: "tc1" });
    // errored
    toolStarted(dispatch, { toolCallId: "tc-2", spanId: "tc2" });
    toolError(dispatch, { toolCallId: "tc-2", spanId: "tc2", errorCategory: "Timeout" });
    // blocked
    toolStarted(dispatch, { toolCallId: "tc-3", spanId: "tc3" });
    toolBlocked(dispatch, { toolCallId: "tc-3", spanId: "tc3" });
    runCompleted(dispatch);
    await finish();
    const byId = (id: string) => exporter.getFinishedSpans().find(s => s.attributes["gen_ai.tool.call.id"] === id);
    const ok = byId("tc-1");
    const errored = byId("tc-2");
    const blocked = byId("tc-3");
    assert(ok);
    assert(errored);
    assert(blocked);
    expect(ok.name).toBe("execute_tool");
    expect(ok.attributes["gen_ai.tool.name"]).toBe("search");
    expect(ok.attributes["gen_ai.tool.call.arguments"]).toBe('{"q":"weave"}');
    expect(ok.attributes["gen_ai.tool.call.result"]).toBe('{"hits":7}');
    expect(ok.status.code).not.toBe(2); // completed tool is not an error
    expect(errored.status.code).toBe(2);
    expect(blocked.status.code).toBe(2);
  });

  it("does not stamp gen_ai.tool.call.* content when captureContent=false", async () => {
    const { dispatch, finish } = await setupTurn({ captureContent: false });
    dispatch.hook("before_tool_call", { runId: "r", toolCallId: "tc-nc", toolName: "search", params: { q: "secret" } });
    toolStarted(dispatch, { toolCallId: "tc-nc", spanId: "tcnc" });
    dispatch.hook("after_tool_call", { runId: "r", toolCallId: "tc-nc", result: { secret: "shhh" } });
    toolCompleted(dispatch, { toolCallId: "tc-nc", spanId: "tcnc" });
    runCompleted(dispatch);
    await finish();
    const span = exporter.getFinishedSpans().find(s => s.attributes["gen_ai.tool.call.id"] === "tc-nc");
    assert(span); // the execute_tool span is still emitted; only its content is withheld
    expect(span.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(span.attributes["gen_ai.tool.call.result"]).toBeUndefined();
  });

  it("records a tool.loop event on the Turn (resolved via sessionKey, which the event carries instead of runId)", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.diagnostic({
      type: "tool.loop",
      ts: 1200,
      sessionKey: "s", // tool.loop omits runId; sessionKey maps back to the run's Turn
      toolName: "search",
      level: "warning",
      action: "warn",
      detector: "generic_repeat",
      count: 3,
      message: "repeated tool call",
    });
    runCompleted(dispatch);
    await finish();
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    assert(turn);
    const loop = turn.events.find(e => e.name === "tool.loop");
    assert(loop);
    assert(loop.attributes);
    expect(loop.attributes["gen_ai.tool.name"]).toBe("search");
    expect(loop.attributes["weave.loop.level"]).toBe("warning");
    expect(loop.attributes["weave.loop.action"]).toBe("warn");
    expect(loop.attributes["weave.loop.detector"]).toBe("generic_repeat");
    expect(loop.attributes["weave.loop.count"]).toBe(3);
    expect(loop.attributes["weave.loop.message"]).toBe("repeated tool call");
  });
});
describe("side-channel attrs on Turn", () => {
  it("accumulates cost and stamps usage totals from model.usage", async () => {
    const { dispatch, finish } = await setupTurn();
    modelUsage(dispatch, { costUsd: 0.05 });
    modelUsage(dispatch, { costUsd: 0.10 });
    modelUsage(dispatch, { usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 30, total: 380 } });
    runCompleted(dispatch);
    await finish();
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    assert(turn);
    expect(turn.attributes["weave.cost.usd"]).toBeCloseTo(0.15);
    expect(turn.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(turn.attributes["gen_ai.usage.output_tokens"]).toBe(50);
    expect(turn.attributes["gen_ai.usage.total_tokens"]).toBe(380);
    expect(turn.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(200);
    expect(turn.attributes["gen_ai.usage.cache_creation.input_tokens"]).toBe(30);
  });

  it("records run.attempt / message_received span events and context.assembled attrs", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.diagnostic({ type: "context.assembled", ts: 2, runId: "r", contextTokenBudget: 200000, messageCount: 12, historyTextChars: 5000, promptChars: 200, trace: TRACE });
    dispatch.diagnostic({ type: "run.attempt", ts: 3, runId: "r", attempt: 2, trace: TRACE });
    dispatch.hook("message_received", { runId: "r", from: "user@example.com", content: "hello" }, { channelId: "telegram" });
    runCompleted(dispatch);
    await finish();
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    assert(turn);
    expect(turn.attributes["weave.context.budget_tokens"]).toBe(200000);
    expect(turn.attributes["weave.context.message_count"]).toBe(12);
    expect(turn.attributes["weave.context.history_text_chars"]).toBe(5000);
    expect(turn.attributes["weave.context.prompt_chars"]).toBe(200);
    expect(turn.events.find(e => e.name === "run_attempt")?.attributes?.["weave.run.attempt"]).toBe(2);
    const msg = turn.events.find(e => e.name === "message_received");
    assert(msg);
    assert(msg.attributes);
    expect(msg.attributes["weave.message.from"]).toBe("user@example.com");
    expect(msg.attributes["weave.message.channel"]).toBe("telegram");
    expect(msg.attributes["weave.message.content"]).toBe("hello");
  });

  it("agent_end stamps success/duration as attributes (not a duplicate timeline event)", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("agent_end", { runId: "r", success: true, durationMs: 1200, messages: [] });
    runCompleted(dispatch);
    await finish();
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    assert(turn);
    expect(turn.events.find(e => e.name === "agent_end_summary")).toBeUndefined();
    expect(turn.attributes["weave.agent.success"]).toBe(true);
    expect(turn.attributes["weave.agent.duration_ms"]).toBe(1200);
  });
});

describe("concurrent runs", () => {
  it("two interleaved runs each get their own Turn / LLM / Tool spans without colliding on the SDK's ambient state", async () => {
    const { plugin, dispatch, finish } = await bootPlugin();

    // Interleave events for two concurrent runs. Each `runIsolated()`
    // boundary in the handlers must let both runs' SDK constructions
    // succeed; without it the second startTurn would throw "X is already
    // active in this async chain."
    runStarted(dispatch, { runId: "r-A", sessionKey: "s-A", trace: { traceId: "ta", spanId: "spa" } });
    runStarted(dispatch, { runId: "r-B", sessionKey: "s-B", trace: { traceId: "tb", spanId: "spb" } });
    expect(plugin.registries.turns.has("r-A")).toBe(true);
    expect(plugin.registries.turns.has("r-B")).toBe(true);

    dispatch.hook("model_call_started", { runId: "r-A", callId: "c-A" });
    dispatch.hook("model_call_started", { runId: "r-B", callId: "c-B" });
    modelCallStarted(dispatch, { runId: "r-A", callId: "c-A", spanId: "csa", parentSpanId: "spa", traceId: "ta" });
    modelCallStarted(dispatch, { runId: "r-B", callId: "c-B", spanId: "csb", parentSpanId: "spb", traceId: "tb" });
    expect(plugin.registries.calls.has("c-A")).toBe(true);
    expect(plugin.registries.calls.has("c-B")).toBe(true);

    dispatch.hook("llm_input", { runId: "r-A", prompt: "from A" });
    dispatch.hook("llm_input", { runId: "r-B", prompt: "from B" });
    dispatch.hook("llm_output", { runId: "r-A", assistantTexts: ["A answered"], usage: { input: 1, output: 1 } });
    dispatch.hook("llm_output", { runId: "r-B", assistantTexts: ["B answered"], usage: { input: 2, output: 2 } });
    modelCallCompleted(dispatch, { runId: "r-A", callId: "c-A", spanId: "csa", traceId: "ta" });
    modelCallCompleted(dispatch, { runId: "r-B", callId: "c-B", spanId: "csb", traceId: "tb" });

    runCompleted(dispatch, { runId: "r-A", sessionKey: "s-A", trace: { traceId: "ta", spanId: "spa" } });
    runCompleted(dispatch, { runId: "r-B", sessionKey: "s-B", trace: { traceId: "tb", spanId: "spb" } });
    await finish();

    const spans = exporter.getFinishedSpans();
    const turns = spans.filter(s => s.name === "invoke_agent");
    const chats = spans.filter(s => s.name === "chat");
    expect(turns.length).toBe(2);
    expect(chats.length).toBe(2);
    // Each chat's input/output stayed attached to its own run.
    const aChat = chats.find(s => String(s.attributes["gen_ai.input.messages"] ?? "").includes("from A"));
    const bChat = chats.find(s => String(s.attributes["gen_ai.input.messages"] ?? "").includes("from B"));
    expect(aChat).toBeDefined();
    expect(bChat).toBeDefined();
    expect(String(aChat?.attributes["gen_ai.output.messages"])).toContain("A answered");
    expect(String(bChat?.attributes["gen_ai.output.messages"])).toContain("B answered");
  });
});

describe("hot-reload / lifecycle", () => {
  it("start() called twice without an intervening stop() drops accumulated per-run state from the previous start", async () => {
    const { plugin, hookState, dispatch } = await bootPlugin();
    // Open some state under the first start().
    runStarted(dispatch, { runId: "r-1" });
    dispatch.hook("session_start", { sessionKey: "s" });
    modelUsage(dispatch, { runId: "r-1", costUsd: 0.42 });
    expect(plugin.registries.turns.size).toBeGreaterThan(0);

    // Second start() with no stop() in between — simulates plugin
    // re-registration or hot-reload. All per-run registries plus cost /
    // compaction accumulators must reset, otherwise leaked state from the
    // previous lifecycle leaks into the next.
    await plugin.service.start({ logger: makeLogger() } as any);
    expect(plugin.registries.turns.size).toBe(0);
    expect(plugin.registries.sessions.size).toBe(0);
    expect(plugin.registries.calls.size).toBe(0);
    expect(plugin.registries.tools.size).toBe(0);
    expect(plugin.registries.subagents.size).toBe(0);
    expect(hookState.chatCallsByRun.size).toBe(0);
    expect(hookState.assistantOutputByRun.size).toBe(0);

    await plugin.service.stop({ logger: makeLogger() } as any);
  });
});

describe("subagent and compaction", () => {
  const compactedEvent = () =>
    exporter.getFinishedSpans()
      .find(s => s.name === "invoke_agent")
      ?.events.find(e => e.name === "context_compacted");

  it("opens a SubAgent under the requester's Turn with spawned-event attrs; non-ok ends ERROR", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("subagent_spawned", { runId: "sub-r", agentId: "researcher", label: "search-agent", childSessionKey: "sub-s", mode: "run" }, { runId: "r" });
    dispatch.hook("subagent_ended", { runId: "sub-r", outcome: "ok" });
    dispatch.hook("subagent_spawned", { runId: "sub-r2", agentId: "broken", childSessionKey: "sub-s2", mode: "run" }, { runId: "r" });
    dispatch.hook("subagent_ended", { runId: "sub-r2", outcome: "killed" });
    runCompleted(dispatch);
    await finish();
    const spans = exporter.getFinishedSpans();
    const researcher = spans.find(s => s.attributes["gen_ai.agent.name"] === "researcher");
    const broken = spans.find(s => s.attributes["gen_ai.agent.name"] === "broken");
    assert(researcher);
    assert(broken);
    expect(broken.status.code).toBe(2);
    // The requester Turn is the invoke_agent span that recorded the spawn events;
    // sub-agent spans are also invoke_agent but carry the sub's gen_ai.agent.name.
    const requester = spans.find(s => s.name === "invoke_agent" && s.events.some(e => e.name === "subagent_spawned"));
    assert(requester);
    const ev = requester.events.find(e => e.name === "subagent_spawned" && e.attributes?.["weave.agent.id"] === "researcher");
    assert(ev);
    assert(ev.attributes);
    expect(ev.attributes["weave.subagent.mode"]).toBe("run");
    expect(ev.attributes["weave.agent.description"]).toBe("search-agent");
    expect(ev.attributes["gen_ai.conversation.id"]).toBe("sub-s");
  });

  it("does not open a subagent when no requester turn exists", async () => {
    const { plugin, dispatch, finish } = await setupTurn();
    dispatch.hook("subagent_spawned", { runId: "sub-orphan", agentId: "orphan", childSessionKey: "ck", mode: "run" }, { runId: "missing" });
    expect(plugin.registries.subagents.has("sub-orphan")).toBe(false);
    runCompleted(dispatch);
    await finish();
  });

  it("emits context_compacted with items_before from before_compaction", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("before_compaction", { messageCount: 50, tokenCount: 100000, compactingCount: 40 }, { runId: "r" });
    dispatch.hook("after_compaction", { messageCount: 10, tokenCount: 20000 }, { runId: "r" });
    runCompleted(dispatch);
    await finish();
    const ev = compactedEvent();
    assert(ev);
    assert(ev.attributes);
    expect(ev.attributes["weave.compaction.items_before"]).toBe(50);
    expect(ev.attributes["weave.compaction.items_after"]).toBe(10);
  });

  it("infers items_before from after_compaction.compactedCount when before_compaction never fired", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("after_compaction", { messageCount: 10, tokenCount: 20000, compactedCount: 30 }, { runId: "r" });
    runCompleted(dispatch);
    await finish();
    const ev = compactedEvent();
    assert(ev);
    assert(ev.attributes);
    expect(ev.attributes["weave.compaction.items_before"]).toBe(40);
    expect(ev.attributes["weave.compaction.items_after"]).toBe(10);
  });
});
