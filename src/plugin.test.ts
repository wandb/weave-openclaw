// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { init as weaveInit, startTurn } from "weave";

async function bootPlugin(extraConfig: Record<string, unknown> = {}) {
  const { createWeavePlugin } = await import("./plugin.js");
  const { createWeaveHookState } = await import("./state/hook-state.js");
  const hookState = createWeaveHookState();
  const plugin = createWeavePlugin({
    pluginConfig: { entity: "e", project: "p", apiKey: "k", ...extraConfig },
    hookState,
  });
  await plugin.service.start({ logger: makeLogger() } as any);
  const dispatch = makeFakeApi(plugin);
  return {
    plugin,
    hookState,
    dispatch,
    finish: () => plugin.service.stop({ logger: makeLogger() } as any),
  };
}

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

const exporter = new InMemorySpanExporter();

beforeEach(async () => {
  exporter.reset();
  process.env.WANDB_API_KEY = "test-key";
  await weaveInit("test/test", {
    genai: { spanProcessor: new SimpleSpanProcessor(exporter) },
  });
  // Warmup forces the SDK's lazy provider build NOW so the cached
  // provider gets pinned with the test's SimpleSpanProcessor. The
  // SDK's getOrBuildProvider is first-call-wins (weave/sdks/node/src/
  // genai/provider.ts:71-74): subsequent weave.init() updates the
  // global client but the existing provider keeps its original
  // settings. Without warmup, the plugin's service.start() weaveInit
  // would land first; the plugin's first startTurn would then build
  // the provider with the plugin's batch config and no test exporter
  // pinned, so the test sees zero spans. The warmup span itself is
  // discarded via reset().
  startTurn({ agentName: "warmup" }).end();
  exporter.reset();
});

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function emptyHookState() {
  return {
    llmInputs: new Map(),
    currentCallByRun: new Map(),
    pendingLlmInputByRun: new Map(),
    toolCallArgs: new Map(),
    toolCallResults: new Map(),
    chatCallsByRun: new Map(),
    assistantOutputByRun: new Map(),
  } as any;
}

describe("createWeavePlugin lifecycle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("transitions to running on start with a valid config", async () => {
    const { createWeavePlugin } = await import("./plugin.js");
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "rgao", project: "p", apiKey: "k" },
      hookState: emptyHookState(),
    });
    await plugin.service.start({ logger: makeLogger() } as any);
    const status = plugin.getStatus();
    expect(status.lifecycle).toBe("running");
    expect(status.config?.projectId).toBe("rgao/p");
  });

  it("transitions to stopped after stop", async () => {
    const { createWeavePlugin } = await import("./plugin.js");
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "e", project: "p", apiKey: "k" },
      hookState: emptyHookState(),
    });
    await plugin.service.start({ logger: makeLogger() } as any);
    await plugin.service.stop({ logger: makeLogger() } as any);
    expect(plugin.getStatus().lifecycle).toBe("stopped");
  });

  it("transitions to disabled and warns when enabled=false", async () => {
    const { createWeavePlugin } = await import("./plugin.js");
    const log = makeLogger();
    const plugin = createWeavePlugin({
      pluginConfig: { enabled: false, entity: "e", project: "p" },
      hookState: emptyHookState(),
    });
    await plugin.service.start({ logger: log } as any);
    expect(plugin.getStatus().lifecycle).toBe("disabled");
    expect(log.warn).toHaveBeenCalled();
  });

  it("transitions to config-error when entity and $USER are both unset", async () => {
    vi.stubEnv("USER", "");
    vi.stubEnv("USERNAME", "");
    const { createWeavePlugin } = await import("./plugin.js");
    const log = makeLogger();
    const plugin = createWeavePlugin({
      pluginConfig: { apiKey: "k" },
      hookState: emptyHookState(),
    });
    await plugin.service.start({ logger: log } as any);
    expect(plugin.getStatus().lifecycle).toBe("config-error");
    expect(log.error).toHaveBeenCalled();
  });

  it("registers config snapshot in getStatus when running", async () => {
    const { createWeavePlugin } = await import("./plugin.js");
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "rgao", project: "p", apiKey: "k", serviceName: "svc-x" },
      hookState: emptyHookState(),
    });
    await plugin.service.start({ logger: makeLogger() } as any);
    const status = plugin.getStatus();
    expect(status.config?.serviceName).toBe("svc-x");
    expect(status.config?.authSource).toBe("literal");
    expect(status.counts).toEqual({ turns: 0, calls: 0, tools: 0, subagents: 0 });
  });
});

describe("turn lifecycle", () => {
  it("opens a Turn on run.started", async () => {
    const { plugin, dispatch, finish } = await bootPlugin();
    dispatch.diagnostic({
      type: "run.started",
      ts: 1000,
      runId: "r-1",
      sessionKey: "s-1",
      trace: { traceId: "t", spanId: "sp" },
    });
    expect(plugin.registries.turns.has("r-1")).toBe(true);
    // Close the turn so the span doesn't leak.
    dispatch.diagnostic({
      type: "run.completed",
      ts: 1100,
      runId: "r-1",
      sessionKey: "s-1",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "completed",
    });
    await finish();
  });

  it("ends the Turn on run.completed and exports invoke_agent span", async () => {
    const { plugin, dispatch, finish } = await bootPlugin();
    dispatch.diagnostic({
      type: "run.started",
      ts: 1000,
      runId: "r-1",
      sessionKey: "s-1",
      trace: { traceId: "t", spanId: "sp" },
    });
    dispatch.diagnostic({
      type: "run.completed",
      ts: 2000,
      runId: "r-1",
      sessionKey: "s-1",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "completed",
    });
    await finish();
    expect(plugin.registries.turns.has("r-1")).toBe(false);
    const spans = exporter.getFinishedSpans();
    expect(spans.some(s => s.name === "invoke_agent")).toBe(true);
  });

  it("keeps the Turn OK when outcome is 'aborted' (user-cancel, not a failure) but stamps the outcome attr", async () => {
    const { dispatch, finish } = await bootPlugin();
    dispatch.diagnostic({
      type: "run.started",
      ts: 1000,
      runId: "r-2",
      sessionKey: "s-2",
      trace: { traceId: "t", spanId: "sp" },
    });
    dispatch.diagnostic({
      type: "run.completed",
      ts: 2000,
      runId: "r-2",
      sessionKey: "s-2",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "aborted",
    });
    await finish();
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    expect(turn?.attributes["weave.outcome"]).toBe("aborted");
    // 0 = UNSET, 1 = OK, 2 = ERROR. User-cancel must NOT light up the
    // Agents-tab error-rate panels.
    expect(turn?.status.code).not.toBe(2);
  });

  it("marks the Turn as error when outcome is an actual failure ('failed')", async () => {
    const { dispatch, finish } = await bootPlugin();
    dispatch.diagnostic({
      type: "run.started",
      ts: 1000,
      runId: "r-fail",
      sessionKey: "s-fail",
      trace: { traceId: "t", spanId: "sp" },
    });
    dispatch.diagnostic({
      type: "run.completed",
      ts: 2000,
      runId: "r-fail",
      sessionKey: "s-fail",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "failed",
    });
    await finish();
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    expect(turn?.attributes["weave.outcome"]).toBe("failed");
    expect(turn?.status.code).toBe(2); // ERROR
  });

  it("falls back to the default agent name when config omits agentName", async () => {
    const ctx = await bootPlugin();  // no explicit agentName
    ctx.dispatch.diagnostic({
      type: "run.started",
      ts: 1000,
      runId: "r-anon",
      sessionKey: "s-anon",
      trace: { traceId: "t", spanId: "sp" },
    });
    ctx.dispatch.diagnostic({
      type: "run.completed",
      ts: 2000,
      runId: "r-anon",
      sessionKey: "s-anon",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "completed",
    });
    await ctx.finish();
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    expect(turn?.attributes["gen_ai.agent.name"]).toBeDefined();
    expect(turn?.attributes["gen_ai.agent.name"]).not.toBe("");
  });

  it("opens a Session on session_start and ends on session_end", async () => {
    const { plugin, dispatch, finish } = await bootPlugin();
    dispatch.hook("session_start", { sessionKey: "s-1" });
    expect(plugin.registries.sessions.has("s-1")).toBe(true);
    dispatch.hook("session_end", { sessionKey: "s-1" });
    await finish();
    expect(plugin.registries.sessions.has("s-1")).toBe(false);
  });

  it("agent_end stamps success/error/duration attrs on the active Turn", async () => {
    const { dispatch, finish } = await bootPlugin();
    dispatch.diagnostic({
      type: "run.started",
      ts: 1000,
      runId: "r-3",
      sessionKey: "s-3",
      trace: { traceId: "t", spanId: "sp" },
    });
    dispatch.hook("agent_end", { runId: "r-3", success: true, durationMs: 1500 });
    dispatch.diagnostic({
      type: "run.completed",
      ts: 2000,
      runId: "r-3",
      sessionKey: "s-3",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "completed",
    });
    await finish();
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    expect(turn?.attributes["weave.agent.success"]).toBe(true);
    expect(turn?.attributes["weave.agent.duration_ms"]).toBe(1500);
  });

  it("agent_end does not stamp success when success is absent", async () => {
    const { dispatch, finish } = await bootPlugin();
    dispatch.diagnostic({
      type: "run.started",
      ts: 1000,
      runId: "r-no-success",
      sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" },
    });
    dispatch.hook("agent_end", { runId: "r-no-success", durationMs: 100 });
    dispatch.diagnostic({
      type: "run.completed",
      ts: 2000,
      runId: "r-no-success",
      sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "completed",
    });
    await finish();
    const turn = exporter.getFinishedSpans().find(s => s.attributes["weave.agent.duration_ms"] === 100);
    expect(turn).toBeDefined();
    expect(turn?.attributes["weave.agent.success"]).toBeUndefined();
  });

  it("agent_end stamps success=false when explicitly false", async () => {
    const { dispatch, finish } = await bootPlugin();
    dispatch.diagnostic({
      type: "run.started",
      ts: 1000,
      runId: "r-failed",
      sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" },
    });
    dispatch.hook("agent_end", { runId: "r-failed", success: false });
    dispatch.diagnostic({
      type: "run.completed",
      ts: 2000,
      runId: "r-failed",
      sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "completed",
    });
    await finish();
    const turn = exporter.getFinishedSpans().find(s => s.attributes["weave.agent.success"] === false);
    expect(turn).toBeDefined();
  });
});

describe("llm two-signal close", () => {
  async function setupTurn() {
    const ctx = await bootPlugin();
    ctx.dispatch.diagnostic({
      type: "run.started",
      ts: 1000,
      runId: "r",
      sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" },
    });
    return ctx;
  }

  it("closes the chat span when llm_output and model.call.completed both arrive", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("model_call_started", { runId: "r", callId: "c-1" });
    dispatch.diagnostic({
      type: "model.call.started",
      ts: 1100,
      runId: "r",
      callId: "c-1",
      model: "gpt-4o",
      trace: { traceId: "t", spanId: "sp2", parentSpanId: "sp" },
    });
    dispatch.hook("llm_input", { runId: "r", prompt: "hi", systemPrompt: "be helpful" });
    dispatch.hook("llm_output", {
      runId: "r",
      assistantTexts: ["hello"],
      usage: { input: 5, output: 3 },
    });
    dispatch.diagnostic({
      type: "model.call.completed",
      ts: 1500,
      runId: "r",
      callId: "c-1",
      trace: { traceId: "t", spanId: "sp2" },
    });
    // Close the turn so the span exports.
    dispatch.diagnostic({
      type: "run.completed",
      ts: 1600,
      runId: "r",
      sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "completed",
    });
    await finish();
    const chat = exporter.getFinishedSpans().find(s => s.name === "chat");
    expect(chat).toBeDefined();
    expect(chat?.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(chat?.attributes["gen_ai.usage.input_tokens"]).toBe(5);
    expect(chat?.attributes["gen_ai.usage.output_tokens"]).toBe(3);
  });

  it("closes immediately on model.call.error without llm_output", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("model_call_started", { runId: "r", callId: "c-1" });
    dispatch.diagnostic({
      type: "model.call.started",
      ts: 1100,
      runId: "r",
      callId: "c-1",
      model: "gpt-4o",
      trace: { traceId: "t", spanId: "sp2", parentSpanId: "sp" },
    });
    dispatch.diagnostic({
      type: "model.call.error",
      ts: 1200,
      runId: "r",
      callId: "c-1",
      errorCategory: "ProviderTimeout",
      trace: { traceId: "t", spanId: "sp2" },
    });
    dispatch.diagnostic({
      type: "run.completed",
      ts: 1300,
      runId: "r",
      sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "completed",
    });
    await finish();
    const chat = exporter.getFinishedSpans().find(s => s.name === "chat");
    expect(chat).toBeDefined();
    expect(chat?.status.code).toBe(2); // ERROR
  });

  it("promotes pendingLlmInputByRun when model_call_started arrives after llm_input", async () => {
    const { dispatch, hookState, finish } = await setupTurn();
    // llm_input fires before model_call_started — capture should buffer
    // on pendingLlmInputByRun keyed by runId.
    dispatch.hook("llm_input", { runId: "r", prompt: "hi" });
    expect(hookState.pendingLlmInputByRun.has("r")).toBe(true);
    dispatch.hook("model_call_started", { runId: "r", callId: "c-promote" });
    // Now the buffered input should be promoted to llmInputs[c-promote].
    expect(hookState.pendingLlmInputByRun.has("r")).toBe(false);
    expect(hookState.llmInputs.has("c-promote")).toBe(true);
    // Close the turn so the span doesn't leak.
    dispatch.diagnostic({
      type: "run.completed",
      ts: 2000,
      runId: "r",
      sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "completed",
    });
    await finish();
  });
});

describe("tool lifecycle", () => {
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

  it("opens an execute_tool span at tool.execution.started and ends at completed", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("before_tool_call", {
      runId: "r",
      toolCallId: "tc-1",
      toolName: "search",
      params: { q: "weave" },
    });
    dispatch.diagnostic({
      type: "tool.execution.started",
      ts: 1100,
      runId: "r",
      toolCallId: "tc-1",
      toolName: "search",
      trace: { traceId: "t", spanId: "tcsp", parentSpanId: "sp" },
    });
    dispatch.hook("after_tool_call", {
      runId: "r",
      toolCallId: "tc-1",
      result: { hits: 7 },
    });
    dispatch.diagnostic({
      type: "tool.execution.completed",
      ts: 1300,
      runId: "r",
      toolCallId: "tc-1",
      trace: { traceId: "t", spanId: "tcsp" },
    });
    await endRun(dispatch, finish);
    const span = exporter.getFinishedSpans().find(s => s.name === "execute_tool");
    expect(span).toBeDefined();
    expect(span?.attributes["gen_ai.tool.name"]).toBe("search");
    expect(span?.attributes["gen_ai.tool.call.id"]).toBe("tc-1");
    expect(span?.attributes["gen_ai.tool.call.arguments"]).toBe('{"q":"weave"}');
    expect(span?.attributes["gen_ai.tool.call.result"]).toBe('{"hits":7}');
  });

  it("records error status on tool.execution.error", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.diagnostic({
      type: "tool.execution.started",
      ts: 1100,
      runId: "r",
      toolCallId: "tc-2",
      toolName: "search",
      trace: { traceId: "t", spanId: "tcsp2", parentSpanId: "sp" },
    });
    dispatch.diagnostic({
      type: "tool.execution.error",
      ts: 1300,
      runId: "r",
      toolCallId: "tc-2",
      errorCategory: "Timeout",
      trace: { traceId: "t", spanId: "tcsp2" },
    });
    await endRun(dispatch, finish);
    const span = exporter.getFinishedSpans().find(s => s.attributes["gen_ai.tool.call.id"] === "tc-2");
    expect(span).toBeDefined();
    expect(span?.status.code).toBe(2); // ERROR
  });

  it("records blocked tools as error", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.diagnostic({
      type: "tool.execution.started",
      ts: 1100,
      runId: "r",
      toolCallId: "tc-3",
      toolName: "search",
      trace: { traceId: "t", spanId: "tcsp3", parentSpanId: "sp" },
    });
    dispatch.diagnostic({
      type: "tool.execution.blocked",
      ts: 1300,
      runId: "r",
      toolCallId: "tc-3",
      trace: { traceId: "t", spanId: "tcsp3" },
    });
    await endRun(dispatch, finish);
    const span = exporter.getFinishedSpans().find(s => s.attributes["gen_ai.tool.call.id"] === "tc-3");
    expect(span?.status.code).toBe(2); // ERROR
  });

  it("does not stamp gen_ai.tool.call.* content when captureContent=false", async () => {
    const { createWeavePlugin } = await import("./plugin.js");
    const { createWeaveHookState } = await import("./state/hook-state.js");
    const hookState = createWeaveHookState();
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "e", project: "p", apiKey: "k", captureContent: false },
      hookState,
    });
    await plugin.service.start({ logger: makeLogger() } as any);
    const dispatch = makeFakeApi(plugin);
    dispatch.diagnostic({
      type: "run.started",
      ts: 1,
      runId: "r-nc",
      sessionKey: "s-nc",
      trace: { traceId: "tnc", spanId: "spnc" },
    });
    dispatch.hook("before_tool_call", {
      runId: "r-nc",
      toolCallId: "tc-nc",
      toolName: "search",
      params: { q: "secret" },
    });
    dispatch.diagnostic({
      type: "tool.execution.started",
      ts: 2,
      runId: "r-nc",
      toolCallId: "tc-nc",
      toolName: "search",
      trace: { traceId: "tnc", spanId: "tcspnc", parentSpanId: "spnc" },
    });
    dispatch.hook("after_tool_call", { runId: "r-nc", toolCallId: "tc-nc", result: { secret: "shhh" } });
    dispatch.diagnostic({
      type: "tool.execution.completed",
      ts: 3,
      runId: "r-nc",
      toolCallId: "tc-nc",
      trace: { traceId: "tnc", spanId: "tcspnc" },
    });
    dispatch.diagnostic({
      type: "run.completed",
      ts: 4,
      runId: "r-nc",
      sessionKey: "s-nc",
      trace: { traceId: "tnc", spanId: "spnc" },
      outcome: "completed",
    });
    await plugin.service.stop({ logger: makeLogger() } as any);
    const span = exporter.getFinishedSpans().find(s => s.attributes["gen_ai.tool.call.id"] === "tc-nc");
    expect(span?.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(span?.attributes["gen_ai.tool.call.result"]).toBeUndefined();
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

  it("accumulates cost across multiple model.usage events", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.diagnostic({ type: "model.usage", ts: 1, runId: "r", costUsd: 0.05, trace: { traceId: "t", spanId: "sp" } });
    dispatch.diagnostic({ type: "model.usage", ts: 2, runId: "r", costUsd: 0.10, trace: { traceId: "t", spanId: "sp" } });
    await endRun(dispatch, finish);
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    expect(turn?.attributes["weave.cost.usd"]).toBeCloseTo(0.15);
  });

  it("stamps total usage from model.usage", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.diagnostic({
      type: "model.usage",
      ts: 1,
      runId: "r",
      usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 30, total: 380 },
      trace: { traceId: "t", spanId: "sp" },
    });
    await endRun(dispatch, finish);
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    expect(turn?.attributes["weave.usage.total.input_tokens"]).toBe(100);
    expect(turn?.attributes["weave.usage.total.output_tokens"]).toBe(50);
    expect(turn?.attributes["weave.usage.total.cache_read.input_tokens"]).toBe(200);
    expect(turn?.attributes["weave.usage.total.cache_creation.input_tokens"]).toBe(30);
    expect(turn?.attributes["weave.usage.total.tokens"]).toBe(380);
  });

  it("adds tool.loop as a span event", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.diagnostic({
      type: "tool.loop",
      ts: 1,
      runId: "r",
      toolName: "search",
      level: "warn",
      action: "abort",
      count: 3,
      message: "same args 3x",
      trace: { traceId: "t", spanId: "sp" },
    });
    await endRun(dispatch, finish);
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    const ev = turn?.events.find(e => e.name === "tool.loop");
    expect(ev?.attributes?.["gen_ai.tool.name"]).toBe("search");
    expect(ev?.attributes?.["weave.loop.level"]).toBe("warn");
    expect(ev?.attributes?.["weave.loop.count"]).toBe(3);
    expect(ev?.attributes?.["weave.loop.action"]).toBe("abort");
    expect(ev?.attributes?.["weave.loop.message"]).toBe("same args 3x");
  });

  it("stamps context.assembled fields on the Turn", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.diagnostic({
      type: "context.assembled",
      ts: 1,
      runId: "r",
      contextTokenBudget: 200000,
      messageCount: 12,
      historyTextChars: 5000,
      promptChars: 200,
      trace: { traceId: "t", spanId: "sp" },
    });
    await endRun(dispatch, finish);
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    expect(turn?.attributes["weave.context.budget_tokens"]).toBe(200000);
    expect(turn?.attributes["weave.context.message_count"]).toBe(12);
    expect(turn?.attributes["weave.context.history_text_chars"]).toBe(5000);
    expect(turn?.attributes["weave.context.prompt_chars"]).toBe(200);
  });

  it("adds run.attempt as a span event with attempt number", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.diagnostic({
      type: "run.attempt",
      ts: 1,
      runId: "r",
      attempt: 2,
      trace: { traceId: "t", spanId: "sp" },
    });
    await endRun(dispatch, finish);
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    const ev = turn?.events.find(e => e.name === "run_attempt");
    expect(ev?.attributes?.["weave.run.attempt"]).toBe(2);
  });

  it("adds message_received as a span event with content when captureContent=true", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook(
      "message_received",
      { runId: "r", from: "user@example.com", content: "hello" },
      { channelId: "telegram" },
    );
    await endRun(dispatch, finish);
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    const ev = turn?.events.find(e => e.name === "message_received");
    expect(ev?.attributes?.["weave.message.from"]).toBe("user@example.com");
    expect(ev?.attributes?.["weave.message.channel"]).toBe("telegram");
    expect(ev?.attributes?.["weave.message.content"]).toBe("hello");
  });

  it("agent_end stamps success and duration as Turn attributes (not a duplicate timeline event)", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("agent_end", { runId: "r", success: true, durationMs: 1200, messages: [] });
    await endRun(dispatch, finish);
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    // The agent_end_summary event was removed: its data is redundant with
    // the Turn's own start/end timestamps and the attributes set below.
    // Agents-tab filters and search need these on the span, not as a
    // synthetic timeline event.
    expect(turn?.events.find(e => e.name === "agent_end_summary")).toBeUndefined();
    expect(turn?.attributes["weave.agent.success"]).toBe(true);
    expect(turn?.attributes["weave.agent.duration_ms"]).toBe(1200);
  });
});

describe("subagent and compaction", () => {
  async function setupTurn() {
    const ctx = await bootPlugin();
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

  it("opens and closes a SubAgent under the requester's Turn", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("subagent_spawned", {
      runId: "sub-r",
      agentId: "researcher",
      label: "search-agent",
      childSessionKey: "sub-s",
      mode: "run",
    }, { runId: "r" });
    dispatch.hook("subagent_ended", { runId: "sub-r", outcome: "ok" });
    await endRun(dispatch, finish);
    const sub = exporter.getFinishedSpans().find(s => s.attributes["gen_ai.agent.name"] === "researcher");
    expect(sub).toBeDefined();
    // Verify the parent's subagent_spawned event carries the descriptive attrs.
    // There are two invoke_agent spans: the subagent's own span and the parent
    // turn. The parent is the one that has a subagent_spawned event on it.
    const turn = exporter.getFinishedSpans().find(
      s => s.name === "invoke_agent" && s.events.some(e => e.name === "subagent_spawned"),
    );
    const ev = turn?.events.find(e => e.name === "subagent_spawned");
    expect(ev?.attributes?.["weave.agent.id"]).toBe("researcher");
    expect(ev?.attributes?.["weave.subagent.mode"]).toBe("run");
    expect(ev?.attributes?.["weave.agent.description"]).toBe("search-agent");
    expect(ev?.attributes?.["gen_ai.conversation.id"]).toBe("sub-s");
  });

  it("marks subagent as error when outcome != ok", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("subagent_spawned", {
      runId: "sub-r2",
      agentId: "broken",
      childSessionKey: "sub-s2",
      mode: "run",
    }, { runId: "r" });
    dispatch.hook("subagent_ended", { runId: "sub-r2", outcome: "killed" });
    await endRun(dispatch, finish);
    const sub = exporter.getFinishedSpans().find(s => s.attributes["gen_ai.agent.name"] === "broken");
    expect(sub?.status.code).toBe(2); // ERROR
  });

  it("does not open a subagent when no requester turn exists", async () => {
    const { plugin, dispatch, finish } = await setupTurn();
    dispatch.hook("subagent_spawned", {
      runId: "sub-orphan",
      agentId: "orphan",
      childSessionKey: "ck",
      mode: "run",
    }, { runId: "missing" });
    expect(plugin.registries.subagents.has("sub-orphan")).toBe(false);
    await endRun(dispatch, finish);
  });

  it("adds context_compacted as a span event on the Turn", async () => {
    const { dispatch, finish } = await setupTurn();
    dispatch.hook("before_compaction", { messageCount: 50, tokenCount: 100000, compactingCount: 40 }, { runId: "r" });
    dispatch.hook("after_compaction", { messageCount: 10, tokenCount: 20000 }, { runId: "r" });
    await endRun(dispatch, finish);
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    const ev = turn?.events.find(e => e.name === "context_compacted");
    expect(ev?.attributes?.["items_before"]).toBe(50);
    expect(ev?.attributes?.["items_after"]).toBe(10);
    expect(ev?.attributes?.["tokens"]).toBe(20000);
  });

  it("compaction without prior before_compaction infers items_before from messageCount + compactedCount", async () => {
    const { dispatch, finish } = await setupTurn();
    // No before_compaction; just after_compaction with messageCount + compactedCount.
    dispatch.hook("after_compaction", { messageCount: 10, tokenCount: 20000, compactedCount: 30 }, { runId: "r" });
    await endRun(dispatch, finish);
    const turn = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
    const ev = turn?.events.find(e => e.name === "context_compacted");
    expect(ev?.attributes?.["items_before"]).toBe(40);
    expect(ev?.attributes?.["items_after"]).toBe(10);
  });
});

// Targeted regression tests for design-pressure points: concurrent-runs and
// hot-reload exercise the ambient-state and lifecycle invariants the rest of
// the suite assumes. Surplus-text covers the closeRunChatSpans fallback that
// was previously silent.
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

describe("closeRunChatSpans surplus / scarcity attribution", () => {
  async function multiCallRun(textsFromOutput: string[]): Promise<typeof exporter.getFinishedSpans extends () => infer R ? R : never> {
    const { dispatch, finish } = await bootPlugin();
    dispatch.diagnostic({ type: "run.started", ts: 1000, runId: "r", sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" } });
    // Two model calls -> two chat spans tracked.
    dispatch.hook("model_call_started", { runId: "r", callId: "c-1" });
    dispatch.diagnostic({ type: "model.call.started", ts: 1100, runId: "r", callId: "c-1",
      model: "gpt-4o", trace: { traceId: "t", spanId: "cs1", parentSpanId: "sp" } });
    dispatch.diagnostic({ type: "model.call.completed", ts: 1150, runId: "r", callId: "c-1",
      trace: { traceId: "t", spanId: "cs1" } });
    dispatch.hook("model_call_started", { runId: "r", callId: "c-2" });
    dispatch.diagnostic({ type: "model.call.started", ts: 1200, runId: "r", callId: "c-2",
      model: "gpt-4o", trace: { traceId: "t", spanId: "cs2", parentSpanId: "sp" } });
    dispatch.diagnostic({ type: "model.call.completed", ts: 1250, runId: "r", callId: "c-2",
      trace: { traceId: "t", spanId: "cs2" } });
    // llm_output fires once with the given texts (we vary length to trigger
    // surplus / scarcity / exact-match).
    dispatch.hook("llm_output", { runId: "r", assistantTexts: textsFromOutput });
    dispatch.diagnostic({ type: "run.completed", ts: 1500, runId: "r", sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" }, outcome: "completed" });
    await finish();
    return exporter.getFinishedSpans();
  }

  it("surplus: when llm_output carries more texts than tracked chat spans, the last span absorbs the trailing texts joined", async () => {
    const spans = await multiCallRun(["call-1-text", "call-2-text", "trailing-overflow"]);
    const chats = spans.filter(s => s.name === "chat");
    expect(chats.length).toBe(2);
    const outputs = chats.map(s => String(s.attributes["gen_ai.output.messages"] ?? ""));
    // First chat gets the first text.
    expect(outputs[0]).toContain("call-1-text");
    expect(outputs[0]).not.toContain("trailing-overflow");
    // Last chat absorbs texts[1] + texts[2] joined so the user-visible
    // answer is preserved rather than silently dropped.
    expect(outputs[1]).toContain("call-2-text");
    expect(outputs[1]).toContain("trailing-overflow");
  });

  it("scarcity: when llm_output carries fewer texts than tracked chat spans, the last span pads with the last available text", async () => {
    const spans = await multiCallRun(["only-text"]);
    const chats = spans.filter(s => s.name === "chat");
    expect(chats.length).toBe(2);
    const outputs = chats.map(s => String(s.attributes["gen_ai.output.messages"] ?? ""));
    // First chat gets text[0].
    expect(outputs[0]).toContain("only-text");
    // Last chat pads with the last available text (positional fall-through),
    // so the answer still shows on at least one span.
    expect(outputs[1]).toContain("only-text");
  });

  it("logs a warn when the runtime's llm_output text count drifts from the tracked chat-span count", async () => {
    // Capture the logger passed into service.start.
    const log = makeLogger();
    const { createWeavePlugin } = await import("./plugin.js");
    const { createWeaveHookState } = await import("./state/hook-state.js");
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "e", project: "p", apiKey: "k", captureContent: true },
      hookState: createWeaveHookState(),
    });
    await plugin.service.start({ logger: log } as any);
    const d = plugin.handlers.diagnostic!;
    const h = plugin.handlers.hook;
    d({ type: "run.started", ts: 1000, runId: "r", sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" } }, { trusted: true });
    h.model_call_started!({ runId: "r", callId: "c-1" });
    d({ type: "model.call.started", ts: 1100, runId: "r", callId: "c-1", model: "gpt-4o",
      trace: { traceId: "t", spanId: "cs1", parentSpanId: "sp" } }, { trusted: true });
    d({ type: "model.call.completed", ts: 1150, runId: "r", callId: "c-1",
      trace: { traceId: "t", spanId: "cs1" } }, { trusted: true });
    // Two texts, only one chat span tracked.
    h.llm_output!({ runId: "r", assistantTexts: ["a", "b"] });
    d({ type: "run.completed", ts: 1300, runId: "r", sessionKey: "s",
      trace: { traceId: "t", spanId: "sp" }, outcome: "completed" }, { trusted: true });
    await plugin.service.stop({ logger: log } as any);

    const warnCalls = (log.warn as any).mock.calls.map((c: any[]) => String(c[0]));
    const mismatchWarn = warnCalls.find((m: string) => m.includes("did not match tracked chat-span count"));
    expect(mismatchWarn).toBeDefined();
  });
});
