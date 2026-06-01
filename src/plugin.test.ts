// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect, beforeEach, afterEach, vi, assert } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { init as weaveInit, startTurn } from "weave";
import { createWeaveHookState } from "./state/hook-state.js";

// Stub weave.login so tests don't hit the live server or write ~/.netrc.
vi.mock("weave", async (importOriginal) => {
  const actual = await importOriginal<typeof import("weave")>();
  return { ...actual, login: vi.fn().mockResolvedValue(undefined) };
});

const exporter = new InMemorySpanExporter();

beforeEach(async () => {
  exporter.reset();
  vi.stubEnv("WANDB_API_KEY", "test-key");
  await weaveInit("test/test", {
    genai: { spanProcessor: new SimpleSpanProcessor(exporter) },
  });
  // Provider is first-call-wins; pin an in-memory processor (the warmup turn
  // forces it to build) before the plugin's init(), else init builds the real
  // OTLP exporter and stop()'s flush egresses to W&B instead of staying local.
  startTurn({ agentName: "warmup" }).end();
  exporter.reset();
});

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

// Start a running plugin and a fake event dispatcher for the turn-lifecycle suite.
async function bootPlugin(extraConfig: Record<string, unknown> = {}) {
  const { createWeavePlugin } = await import("./plugin.js");
  const hookState = createWeaveHookState();
  const logger = makeLogger();
  const plugin = createWeavePlugin({
    pluginConfig: { entity: "my-team", project: "my-project", apiKey: "k", serviceName: "openclaw-agent", ...extraConfig },
    hookState,
  });
  await plugin.service.start({ logger, config: {} } as any);
  return {
    plugin,
    hookState,
    logger,
    dispatch: makeFakeApi(plugin),
    finish: () => plugin.service.stop({ logger } as any),
  };
}

// Shared run-lifecycle dispatch for the diagnostic suites below.
const trace = { traceId: "t", spanId: "sp" };
const started = (d: any, runId = "r", sessionKey = "s") =>
  d.diagnostic({ type: "run.started", ts: 1000, runId, sessionKey, trace });
const completed = (d: any, runId = "r", outcome = "completed", sessionKey = "s") =>
  d.diagnostic({ type: "run.completed", ts: 2000, runId, sessionKey, trace, outcome });

function makeFakeApi(plugin: any) {
  return {
    hook(name: string, event: any, ctx?: any) {
      const handler = plugin.handlers.hook[name];
      if (handler) handler(event, ctx ?? {});
    },
    diagnostic(event: any) {
      plugin.handlers.diagnostic(event, { trusted: true });
    },
  };
}

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
    started(dispatch, "r-1");
    expect(plugin.registries.turns.has("r-1")).toBe(true);
    completed(dispatch, "r-1");
    await finish();
    expect(plugin.registries.turns.has("r-1")).toBe(false);
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    assert(turn);
    expect(turn.attributes).toMatchInlineSnapshot(`
      {
        "gen_ai.agent.name": "openclaw-agent",
        "gen_ai.conversation.id": "s",
        "gen_ai.operation.name": "invoke_agent",
        "weave.agent.version": "0.0.2",
        "weave.outcome": "completed",
      }
    `);
  });

  it("maps outcome to span status: aborted stays OK, error marks ERROR (weave.outcome stamped)", async () => {
    const { dispatch, finish } = await bootPlugin();
    started(dispatch, "r-ok", "s-ok");
    completed(dispatch, "r-ok", "aborted", "s-ok");
    started(dispatch, "r-bad", "s-bad");
    completed(dispatch, "r-bad", "error", "s-bad");
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
    started(dispatch, "r-1", "s-1");
    completed(dispatch, "r-1", "completed", "s-1");
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
    started(dispatch, "r-yes");
    dispatch.hook("agent_end", { runId: "r-yes", success: true, durationMs: 1500 });
    completed(dispatch, "r-yes");
    started(dispatch, "r-absent");
    dispatch.hook("agent_end", { runId: "r-absent", durationMs: 100 });
    completed(dispatch, "r-absent");
    started(dispatch, "r-false");
    dispatch.hook("agent_end", { runId: "r-false", success: false });
    completed(dispatch, "r-false");
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
        "weave.agent.version": "0.0.2",
        "weave.outcome": "completed",
      }
    `);
    expect(spans[1].attributes).toMatchInlineSnapshot(`
      {
        "gen_ai.agent.name": "openclaw-agent",
        "gen_ai.conversation.id": "s",
        "gen_ai.operation.name": "invoke_agent",
        "weave.agent.duration_ms": 100,
        "weave.agent.version": "0.0.2",
        "weave.outcome": "completed",
      }
    `);
    expect(spans[2].attributes).toMatchInlineSnapshot(`
      {
        "gen_ai.agent.name": "openclaw-agent",
        "gen_ai.conversation.id": "s",
        "gen_ai.operation.name": "invoke_agent",
        "weave.agent.success": false,
        "weave.agent.version": "0.0.2",
        "weave.outcome": "completed",
      }
    `);
  });
});

describe("llm two-signal close", () => {
  async function setupTurn() {
    const ctx = await bootPlugin();
    started(ctx.dispatch);
    return ctx;
  }

  it("buffers llm_input before model_call_started, promotes it, and closes the chat span with model + usage", async () => {
    const { dispatch, hookState, finish } = await setupTurn();
    dispatch.hook("llm_input", { runId: "r", prompt: "hi", systemPrompt: "be helpful" });
    expect(hookState.pendingLlmInputByRun.has("r")).toBe(true);
    dispatch.hook("model_call_started", { runId: "r", callId: "c-1" });
    expect(hookState.pendingLlmInputByRun.has("r")).toBe(false);
    expect(hookState.llmInputs.has("c-1")).toBe(true);
    dispatch.diagnostic({ type: "model.call.started", ts: 1100, runId: "r", callId: "c-1", model: "gpt-4o", trace: { traceId: "t", spanId: "sp2", parentSpanId: "sp" } });
    dispatch.hook("llm_output", { runId: "r", assistantTexts: ["hello"], usage: { input: 5, output: 3 } });
    dispatch.diagnostic({ type: "model.call.completed", ts: 1500, runId: "r", callId: "c-1", trace: { traceId: "t", spanId: "sp2" } });
    completed(dispatch);
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
    dispatch.diagnostic({ type: "model.call.started", ts: 1100, runId: "r", callId: "c-1", model: "gpt-4o", trace: { traceId: "t", spanId: "sp2", parentSpanId: "sp" } });
    dispatch.diagnostic({ type: "model.call.error", ts: 1200, runId: "r", callId: "c-1", errorCategory: "ProviderTimeout", trace: { traceId: "t", spanId: "sp2" } });
    completed(dispatch);
    await finish();
    const chat = exporter.getFinishedSpans().find(s => s.name === "chat");
    assert(chat);
    expect(chat.status.code).toBe(2);
  });
});

describe("closeRunChatSpans positional attribution", () => {
  async function twoCallRun(texts: string[]) {
    const { dispatch, finish } = await bootPlugin();
    started(dispatch);
    for (const callId of ["c-1", "c-2"]) {
      dispatch.hook("model_call_started", { runId: "r", callId });
      dispatch.diagnostic({ type: "model.call.started", ts: 1100, runId: "r", callId, model: "gpt-4o", trace: { traceId: "t", spanId: callId, parentSpanId: "sp" } });
      dispatch.diagnostic({ type: "model.call.completed", ts: 1150, runId: "r", callId, trace: { traceId: "t", spanId: callId } });
    }
    dispatch.hook("llm_output", { runId: "r", assistantTexts: texts });
    completed(dispatch);
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
    started(dispatch);
    dispatch.hook("model_call_started", { runId: "r", callId: "c-1" });
    dispatch.diagnostic({ type: "model.call.started", ts: 1100, runId: "r", callId: "c-1", model: "gpt-4o", trace: { traceId: "t", spanId: "cs1", parentSpanId: "sp" } });
    dispatch.diagnostic({ type: "model.call.completed", ts: 1150, runId: "r", callId: "c-1", trace: { traceId: "t", spanId: "cs1" } });
    dispatch.hook("llm_output", { runId: "r", assistantTexts: ["a", "b"] }); // 2 texts, 1 tracked span
    completed(dispatch);
    await finish();
    const warned = (logger.warn as any).mock.calls.map((c: any[]) => String(c[0])).some((m: string) => m.includes("did not match tracked chat-span count"));
    expect(warned).toBe(true);
  });
});

describe("tool lifecycle", () => {
  async function setupTurn(captureContent = true) {
    const ctx = await bootPlugin({ captureContent });
    started(ctx.dispatch);
    return ctx;
  }

  it("opens execute_tool spans (stamping captured args/result) and marks error + blocked as ERROR", async () => {
    const { dispatch, finish } = await setupTurn();
    // completed, with captured args + result
    dispatch.hook("before_tool_call", { runId: "r", toolCallId: "tc-1", toolName: "search", params: { q: "weave" } });
    dispatch.diagnostic({ type: "tool.execution.started", ts: 1100, runId: "r", toolCallId: "tc-1", toolName: "search", trace: { traceId: "t", spanId: "tc1", parentSpanId: "sp" } });
    dispatch.hook("after_tool_call", { runId: "r", toolCallId: "tc-1", result: { hits: 7 } });
    dispatch.diagnostic({ type: "tool.execution.completed", ts: 1300, runId: "r", toolCallId: "tc-1", trace: { traceId: "t", spanId: "tc1" } });
    // errored
    dispatch.diagnostic({ type: "tool.execution.started", ts: 1100, runId: "r", toolCallId: "tc-2", toolName: "search", trace: { traceId: "t", spanId: "tc2", parentSpanId: "sp" } });
    dispatch.diagnostic({ type: "tool.execution.error", ts: 1300, runId: "r", toolCallId: "tc-2", errorCategory: "Timeout", trace: { traceId: "t", spanId: "tc2" } });
    // blocked
    dispatch.diagnostic({ type: "tool.execution.started", ts: 1100, runId: "r", toolCallId: "tc-3", toolName: "search", trace: { traceId: "t", spanId: "tc3", parentSpanId: "sp" } });
    dispatch.diagnostic({ type: "tool.execution.blocked", ts: 1300, runId: "r", toolCallId: "tc-3", trace: { traceId: "t", spanId: "tc3" } });
    completed(dispatch);
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
    const { dispatch, finish } = await setupTurn(false);
    dispatch.hook("before_tool_call", { runId: "r", toolCallId: "tc-nc", toolName: "search", params: { q: "secret" } });
    dispatch.diagnostic({ type: "tool.execution.started", ts: 1100, runId: "r", toolCallId: "tc-nc", toolName: "search", trace: { traceId: "t", spanId: "tcnc", parentSpanId: "sp" } });
    dispatch.hook("after_tool_call", { runId: "r", toolCallId: "tc-nc", result: { secret: "shhh" } });
    dispatch.diagnostic({ type: "tool.execution.completed", ts: 1300, runId: "r", toolCallId: "tc-nc", trace: { traceId: "t", spanId: "tcnc" } });
    completed(dispatch);
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
    completed(dispatch);
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
  async function setupTurn() {
    const ctx = await bootPlugin({ captureContent: true });
    ctx.dispatch.diagnostic({
      type: "run.started",
      ts: 1000,
      runId: "r",
      sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" },
    });
    return ctx;
  }

  async function endRun(dispatch: any, finish: () => Promise<void>) {
    dispatch.diagnostic({
      type: "run.completed",
      ts: 9000,
      runId: "r",
      sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "completed",
    });
    await finish();
  }

  const turnSpan = () => exporter.getFinishedSpans().find(s => s.name === "invoke_agent");

  it("accumulates cost and stamps usage totals from model.usage", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.diagnostic({ type: "model.usage", ts: 1, runId: "r", costUsd: 0.05, trace: { traceId: "t", spanId: "sp" } });
    dispatch.diagnostic({ type: "model.usage", ts: 2, runId: "r", costUsd: 0.10, trace: { traceId: "t", spanId: "sp" } });
    dispatch.diagnostic({ type: "model.usage", ts: 3, runId: "r", usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 30, total: 380 }, trace: { traceId: "t", spanId: "sp" } });
    await endRun(dispatch, finish);
    const turn = turnSpan();
    assert(turn);
    expect(turn.attributes["weave.cost.usd"]).toBeCloseTo(0.15);
    expect(turn.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(turn.attributes["gen_ai.usage.output_tokens"]).toBe(50);
    expect(turn.attributes["gen_ai.usage.total_tokens"]).toBe(380);
    expect(turn.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(200);
    expect(turn.attributes["gen_ai.usage.cache_creation.input_tokens"]).toBe(30);
  });

  it("records tool.loop / run.attempt / message_received span events and context.assembled attrs", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.diagnostic({ type: "tool.loop", ts: 1, runId: "r", toolName: "search", level: "warn", action: "abort", count: 3, message: "same args 3x", trace: { traceId: "t", spanId: "sp" } });
    dispatch.diagnostic({ type: "context.assembled", ts: 2, runId: "r", contextTokenBudget: 200000, messageCount: 12, historyTextChars: 5000, promptChars: 200, trace: { traceId: "t", spanId: "sp" } });
    dispatch.diagnostic({ type: "run.attempt", ts: 3, runId: "r", attempt: 2, trace: { traceId: "t", spanId: "sp" } });
    dispatch.hook("message_received", { runId: "r", from: "user@example.com", content: "hello" }, { channelId: "telegram" });
    await endRun(dispatch, finish);
    const turn = turnSpan();
    const loop = turn?.events.find(e => e.name === "tool.loop");
    expect(loop?.attributes?.["gen_ai.tool.name"]).toBe("search");
    expect(loop?.attributes?.["weave.loop.level"]).toBe("warn");
    expect(loop?.attributes?.["weave.loop.action"]).toBe("abort");
    expect(loop?.attributes?.["weave.loop.count"]).toBe(3);
    expect(loop?.attributes?.["weave.loop.message"]).toBe("same args 3x");
    expect(turn?.attributes["weave.context.budget_tokens"]).toBe(200000);
    expect(turn?.attributes["weave.context.message_count"]).toBe(12);
    expect(turn?.attributes["weave.context.history_text_chars"]).toBe(5000);
    expect(turn?.attributes["weave.context.prompt_chars"]).toBe(200);
    expect(turn?.events.find(e => e.name === "run_attempt")?.attributes?.["weave.run.attempt"]).toBe(2);
    const msg = turn?.events.find(e => e.name === "message_received");
    expect(msg?.attributes?.["weave.message.from"]).toBe("user@example.com");
    expect(msg?.attributes?.["weave.message.channel"]).toBe("telegram");
    expect(msg?.attributes?.["weave.message.content"]).toBe("hello");
  });

  it("agent_end stamps success/duration as attributes (not a duplicate timeline event)", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("agent_end", { runId: "r", success: true, durationMs: 1200, messages: [] });
    await endRun(dispatch, finish);
    const turn = turnSpan();
    expect(turn?.events.find(e => e.name === "agent_end_summary")).toBeUndefined();
    expect(turn?.attributes["weave.agent.success"]).toBe(true);
    expect(turn?.attributes["weave.agent.duration_ms"]).toBe(1200);
  });
});

describe("concurrent runs", () => {
  it("two interleaved runs each get their own Turn / LLM / Tool spans without colliding on the SDK's ambient state", async () => {
    const { plugin, dispatch, finish } = await bootPlugin();

    // Interleave events for two concurrent runs. Each `runIsolated()`
    // boundary in the handlers must let both runs' SDK constructions
    // succeed; without it the second startTurn would throw "X is already
    // active in this async chain."
    dispatch.diagnostic({ type: "run.started", ts: 1000, runId: "r-A", sessionKey: "s-A",
      trace: { traceId: "ta", spanId: "spa" } });
    dispatch.diagnostic({ type: "run.started", ts: 1010, runId: "r-B", sessionKey: "s-B",
      trace: { traceId: "tb", spanId: "spb" } });
    expect(plugin.registries.turns.has("r-A")).toBe(true);
    expect(plugin.registries.turns.has("r-B")).toBe(true);

    dispatch.hook("model_call_started", { runId: "r-A", callId: "c-A" });
    dispatch.hook("model_call_started", { runId: "r-B", callId: "c-B" });
    dispatch.diagnostic({ type: "model.call.started", ts: 1100, runId: "r-A", callId: "c-A",
      model: "gpt-4o", trace: { traceId: "ta", spanId: "csa", parentSpanId: "spa" } });
    dispatch.diagnostic({ type: "model.call.started", ts: 1110, runId: "r-B", callId: "c-B",
      model: "gpt-4o", trace: { traceId: "tb", spanId: "csb", parentSpanId: "spb" } });
    expect(plugin.registries.calls.has("c-A")).toBe(true);
    expect(plugin.registries.calls.has("c-B")).toBe(true);

    dispatch.hook("llm_input", { runId: "r-A", prompt: "from A" });
    dispatch.hook("llm_input", { runId: "r-B", prompt: "from B" });
    dispatch.hook("llm_output", { runId: "r-A", assistantTexts: ["A answered"], usage: { input: 1, output: 1 } });
    dispatch.hook("llm_output", { runId: "r-B", assistantTexts: ["B answered"], usage: { input: 2, output: 2 } });
    dispatch.diagnostic({ type: "model.call.completed", ts: 1200, runId: "r-A", callId: "c-A",
      trace: { traceId: "ta", spanId: "csa" } });
    dispatch.diagnostic({ type: "model.call.completed", ts: 1210, runId: "r-B", callId: "c-B",
      trace: { traceId: "tb", spanId: "csb" } });

    dispatch.diagnostic({ type: "run.completed", ts: 1500, runId: "r-A", sessionKey: "s-A",
      trace: { traceId: "ta", spanId: "spa" }, outcome: "completed" });
    dispatch.diagnostic({ type: "run.completed", ts: 1510, runId: "r-B", sessionKey: "s-B",
      trace: { traceId: "tb", spanId: "spb" }, outcome: "completed" });
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
    dispatch.diagnostic({ type: "run.started", ts: 1000, runId: "r-1", sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" } });
    dispatch.hook("session_start", { sessionKey: "s" });
    dispatch.diagnostic({ type: "model.usage", ts: 1100, runId: "r-1", costUsd: 0.42,
      trace: { traceId: "t", spanId: "sp" } });
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
