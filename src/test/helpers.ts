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
