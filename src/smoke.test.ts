// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { vi } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

// Smoke test's own in-memory exporter — isolated from service.test.ts so
// both files can run in the same vitest worker without shared state.
const _smokeExporter = new InMemorySpanExporter();
const _smokeProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(_smokeExporter)],
});

// Capture init calls so tests can assert projectId. Declared via vi.hoisted
// so the reference is available inside the vi.mock factory (which is hoisted
// to the top of the module before other variable declarations).
const { _initSpy } = vi.hoisted(() => ({ _initSpy: vi.fn(async () => {}) }));

vi.mock("weave", () => ({
  init: _initSpy,
  login: vi.fn(async () => {}),
  flushOTel: vi.fn(async () => {
    await _smokeExporter.forceFlush?.();
  }),
  getWeaveTracer: (name: string) => _smokeProvider.getTracer(name),
}));

import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createWeaveService } from "./service.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const ROOT_SPAN_ID = "1111111111111111";

function makeCtx(): OpenClawPluginServiceContext {
  return {
    config: {} as never,
    stateDir: "/tmp/weave-openclaw-smoke",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as never,
  } as OpenClawPluginServiceContext;
}

async function flushAsyncDiagnostics(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

describe("smoke: service initialization and span emission", () => {
  beforeEach(() => {
    process.env.WANDB_API_KEY = "smoke-test-key";
    resetDiagnosticEventsForTest();
    _smokeExporter.reset();
    _initSpy.mockClear();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    _smokeExporter.reset();
    delete process.env.WANDB_API_KEY;
  });

  test("weaveInit is called with entity/project as projectId", async () => {
    const { service } = createWeaveService({
      pluginConfig: {
        entity: "smoke",
        project: "test",
        agentName: "smoke-agent",
        flushIntervalMs: 1000,
      },
    });
    const ctx = makeCtx();
    await service.start(ctx);
    await service.stop?.(ctx);

    // init() is called with "entity/project" as the first argument.
    expect(_initSpy).toHaveBeenCalledOnce();
    expect(_initSpy.mock.calls[0][0]).toBe("smoke/test");
  });

  test("a run.started + run.completed pair produces an invoke_agent span", async () => {
    const { service } = createWeaveService({
      pluginConfig: {
        entity: "smoke",
        project: "test",
        agentName: "smoke-agent",
        flushIntervalMs: 1000,
      },
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-smoke",
      harnessId: "smoke-agent",
      sessionKey: "conv-smoke",
      trace: {
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        traceFlags: "01",
      },
    } as never);
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-smoke",
      harnessId: "smoke-agent",
      durationMs: 100,
      outcome: "completed",
      trace: {
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        traceFlags: "01",
      },
    } as never);
    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const spans = _smokeExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("invoke_agent smoke-agent");
    expect(spans[0].attributes["gen_ai.agent.name"]).toBe("smoke-agent");
    expect(spans[0].attributes["gen_ai.conversation.id"]).toBe("conv-smoke");
  });
});
