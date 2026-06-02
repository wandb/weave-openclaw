// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { vi } from "vitest";
import { createWeaveHookState } from "../state/hook-state.js";

// Weave SDK setup (vi.mock for `weave`, the InMemorySpanExporter, the warmup
// `beforeEach`) stays inside each test file because vi.mock is hoisted per-file
// and the SDK provider is first-call-wins per process — sharing the exporter
// across files via this helper would let the first imported file pin its
// exporter for the whole run.

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
