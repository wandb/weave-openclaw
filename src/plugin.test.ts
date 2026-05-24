// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { init as weaveInit, getWeaveTracer } from "weave";

async function bootPlugin(extraConfig: Record<string, unknown> = {}) {
  const { createWeavePlugin } = await import("./plugin.js");
  const { createWeaveHookState } = await import("./hook-state.js");
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
  // Warmup span forces the SDK's lazy provider build to pin our
  // SimpleSpanProcessor as the active span processor. Without this,
  // the plugin's later weaveInit() call inside service.start() builds
  // a fresh provider WITHOUT our exporter, and tests see 0 spans
  // with no error. The warmup span itself is discarded via reset().
  getWeaveTracer("warmup").startSpan("warmup").end();
  exporter.reset();
});

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function emptyHookState() {
  return {
    llmInputs: new Map(),
    llmOutputs: new Map(),
    currentCallByRun: new Map(),
    pendingLlmInputByRun: new Map(),
    toolCallArgs: new Map(),
    toolCallResults: new Map(),
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

  it("marks the Turn as error when run outcome != 'completed'", async () => {
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
    expect(turn?.status.code).toBe(2); // ERROR
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
