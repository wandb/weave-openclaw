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

describe("createWeavePlugin lifecycle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts running and exposes a config snapshot, then stops", async () => {
    const { createWeavePlugin } = await import("./plugin.js");
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "rgao", project: "p", apiKey: "k", serviceName: "svc-x" },
      hookState: createWeaveHookState(),
    });
    await plugin.service.start({ logger: makeLogger(), config: {} } as any);
    const status = plugin.getStatus();
    expect(status.lifecycle).toBe("running");
    assert(status.config);
    expect(status.config.projectId).toBe("rgao/p");
    expect(status.config.serviceName).toBe("svc-x");
    expect(status.config.authSource).toBe("literal");
    expect(status.counts).toEqual({ turns: 0, calls: 0, tools: 0, subagents: 0 });

    await plugin.service.stop({ logger: makeLogger() } as any);
    expect(plugin.getStatus().lifecycle).toBe("stopped");
  });

  it("stays out of running when disabled or when config resolution fails", async () => {
    const { createWeavePlugin } = await import("./plugin.js");

    const disabledLog = makeLogger();
    const disabled = createWeavePlugin({
      pluginConfig: { enabled: false, entity: "e", project: "p" },
      hookState: createWeaveHookState(),
    });
    await disabled.service.start({ logger: disabledLog, config: {} } as any);
    expect(disabled.getStatus().lifecycle).toBe("disabled");
    expect(disabledLog.warn).toHaveBeenCalled();

    const errorLog = makeLogger();
    const errored = createWeavePlugin({
      pluginConfig: {
        entity: "e",
        project: "p",
        apiKey: { source: "file", id: "/tmp/weave-missing-key-" + Date.now(), provider: "x" },
      },
      hookState: createWeaveHookState(),
    });
    await errored.service.start({ logger: errorLog, config: {} } as any);
    expect(errored.getStatus().lifecycle).toBe("config-error");
    expect(errorLog.error).toHaveBeenCalled();
  });
});
