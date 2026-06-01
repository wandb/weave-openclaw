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
    await endRun(dispatch, finish);
    const byId = (id: string) => exporter.getFinishedSpans().find(s => s.attributes["gen_ai.tool.call.id"] === id);
    const ok = byId("tc-1");
    expect(ok?.name).toBe("execute_tool");
    expect(ok?.attributes["gen_ai.tool.name"]).toBe("search");
    expect(ok?.attributes["gen_ai.tool.call.arguments"]).toBe('{"q":"weave"}');
    expect(ok?.attributes["gen_ai.tool.call.result"]).toBe('{"hits":7}');
    expect(byId("tc-2")?.status.code).toBe(2);
    expect(byId("tc-3")?.status.code).toBe(2);
  });

  it("does not stamp gen_ai.tool.call.* content when captureContent=false", async () => {
    const { createWeavePlugin } = await import("./plugin.js");
    const { createWeaveHookState } = await import("./state/hook-state.js");
    const hookState = createWeaveHookState();
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "my-team", project: "my-project", apiKey: "k", captureContent: false },
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
