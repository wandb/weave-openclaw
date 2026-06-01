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
  const plugin = createWeavePlugin({
    pluginConfig: { entity: "my-team", project: "my-project", apiKey: "k", serviceName: "openclaw-agent", ...extraConfig },
    hookState: createWeaveHookState(),
  });
  await plugin.service.start({ logger: makeLogger(), config: {} } as any);
  return {
    plugin,
    dispatch: makeFakeApi(plugin),
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
  const trace = { traceId: "t", spanId: "sp" };
  const started = (d: any, runId: string, sessionKey = "s") =>
    d.diagnostic({ type: "run.started", ts: 1000, runId, sessionKey, trace });
  const completed = (d: any, runId: string, outcome = "completed", sessionKey = "s") =>
    d.diagnostic({ type: "run.completed", ts: 2000, runId, sessionKey, trace, outcome });

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
    expect(aborted?.status.code).not.toBe(2); // user-cancel must not count as error
    expect(errored?.status.code).toBe(2);
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
