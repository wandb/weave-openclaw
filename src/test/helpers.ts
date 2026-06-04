// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { vi, beforeEach } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createWeaveHookState } from "../state/hook-state.js";

// vi.mock("weave", ...) must stay in each test file: vitest hoists it to the top
// of the importing file, so it can't move here. The exporter + warmup-pin setup
// is not file-specific though, so pinInMemoryExporter() centralizes it; each
// file calls it once for its own exporter (the SDK tracing provider is
// first-call-wins per process, and vitest isolates test files).

export function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

export async function bootPlugin(extraConfig: Record<string, unknown> = {}) {
  // Plugin module is imported dynamically so vi.mock("weave", ...) (hoisted in
  // each test file) is in place before plugin.ts's transitive weave imports
  // resolve — a static import here pins the unmocked module too eagerly.
  const { createWeavePlugin } = await import("../plugin.js");
  const hookState = createWeaveHookState();
  const logger = makeLogger();
  const plugin = createWeavePlugin({
    pluginConfig: {
      entity: "my-team",
      project: "my-project",
      apiKey: "k",
      serviceName: "openclaw-agent",
      ...extraConfig,
    },
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

export function makeFakeApi(plugin: any) {
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

// Register a per-file beforeEach that pins a fresh InMemorySpanExporter as the
// weave tracing provider before any plugin init() builds the real OTLP exporter
// (provider is first-call-wins; the warmup turn forces it to build). Call once
// at module scope per test file; read finished spans off the returned exporter.
export function pinInMemoryExporter() {
  const exporter = new InMemorySpanExporter();
  beforeEach(async () => {
    exporter.reset();
    vi.stubEnv("WANDB_API_KEY", "test-key");
    // Dynamic import so the per-file vi.mock("weave", ...) is applied first.
    const { init: weaveInit, startTurn } = await import("weave");
    await weaveInit("test/test", {
      genai: { spanProcessor: new SimpleSpanProcessor(exporter) },
    });
    startTurn({ agentName: "warmup" }).end();
    exporter.reset();
  });
  return exporter;
}

// Diagnostic-event builders. The plugin correlates open/close events by id
// (runId / callId / toolCallId), so each builder takes the ids the scenario
// varies and defaults the boilerplate (ts, model, trace ids). `trace` carries
// the OTel hierarchy a test sets up. `d` is the dispatch from bootPlugin().
// Loosely typed (`any`) to match the rest of this test harness.
export const TRACE = { traceId: "t", spanId: "sp" };

export const runStarted = (d: any, { runId = "r", sessionKey = "s", ts = 1000, trace = TRACE }: any = {}) =>
  d.diagnostic({ type: "run.started", ts, runId, sessionKey, trace });

export const runCompleted = (d: any, { runId = "r", sessionKey = "s", outcome = "completed", ts = 2000, trace = TRACE }: any = {}) =>
  d.diagnostic({ type: "run.completed", ts, runId, sessionKey, trace, outcome });

export const modelCallStarted = (d: any, { runId = "r", callId, spanId, parentSpanId = "sp", model = "gpt-4o", traceId = "t", ts = 1100 }: any) =>
  d.diagnostic({ type: "model.call.started", ts, runId, callId, model, trace: { traceId, spanId, parentSpanId } });

export const modelCallCompleted = (d: any, { runId = "r", callId, spanId, traceId = "t", ts = 1200 }: any) =>
  d.diagnostic({ type: "model.call.completed", ts, runId, callId, trace: { traceId, spanId } });

export const modelCallError = (d: any, { runId = "r", callId, spanId, errorCategory, traceId = "t", ts = 1200 }: any) =>
  d.diagnostic({ type: "model.call.error", ts, runId, callId, errorCategory, trace: { traceId, spanId } });

export const toolStarted = (d: any, { runId = "r", toolCallId, toolName = "search", spanId, parentSpanId = "sp", traceId = "t", ts = 1100 }: any) =>
  d.diagnostic({ type: "tool.execution.started", ts, runId, toolCallId, toolName, trace: { traceId, spanId, parentSpanId } });

export const toolCompleted = (d: any, { runId = "r", toolCallId, spanId, traceId = "t", ts = 1300 }: any) =>
  d.diagnostic({ type: "tool.execution.completed", ts, runId, toolCallId, trace: { traceId, spanId } });

export const toolError = (d: any, { runId = "r", toolCallId, spanId, errorCategory, traceId = "t", ts = 1300 }: any) =>
  d.diagnostic({ type: "tool.execution.error", ts, runId, toolCallId, errorCategory, trace: { traceId, spanId } });

export const toolBlocked = (d: any, { runId = "r", toolCallId, spanId, traceId = "t", ts = 1300 }: any) =>
  d.diagnostic({ type: "tool.execution.blocked", ts, runId, toolCallId, trace: { traceId, spanId } });

export const modelUsage = (d: any, { runId = "r", costUsd, usage, ts = 1, trace = TRACE }: any) =>
  d.diagnostic({ type: "model.usage", ts, runId, costUsd, usage, trace });

// before_message_write carrying an assistant message — the per-call output source.
// ctx.sessionKey correlates it to the run's in-flight call (sessionKey -> runId via
// runIdBySession -> currentCallByRun). Fires just before that call's model.call.completed.
export const assistantMessage = (
  d: any,
  { sessionKey = "s", text, usage }: { sessionKey?: string; text?: string; usage?: any } = {},
) =>
  d.hook(
    "before_message_write",
    { message: { role: "assistant", content: text ? [{ type: "text", text }] : [], usage } },
    { sessionKey },
  );

// Boot a running plugin and open the default "r" Turn (the start of every
// per-run suite). Close with `runCompleted(dispatch)` + `await finish()`.
export async function setupTurn(extraConfig: Record<string, unknown> = {}) {
  const ctx = await bootPlugin(extraConfig);
  runStarted(ctx.dispatch);
  return ctx;
}
