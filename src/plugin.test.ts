// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { init as weaveInit, getWeaveTracer } from "weave";

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
