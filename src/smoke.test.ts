// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { init as weaveInit, startTurn } from "weave";
import { createWeavePlugin } from "./plugin.js";
import { createWeaveHookState } from "./state/hook-state.js";

// Stub weave.login so the smoke doesn't hit the live server or write ~/.netrc.
vi.mock("weave", async (importOriginal) => {
  const actual = await importOriginal<typeof import("weave")>();
  return { ...actual, login: vi.fn().mockResolvedValue(undefined) };
});

const exporter = new InMemorySpanExporter();

beforeEach(async () => {
  exporter.reset();
  process.env.WANDB_API_KEY = "test";
  await weaveInit("test-entity/test-project", {
    genai: { spanProcessor: new SimpleSpanProcessor(exporter) },
  });
  // SDK provider is first-call-wins; pin the test exporter now, else the
  // plugin's init() wins first and the smoke sees zero spans.
  startTurn({ agentName: "warmup" }).end();
  exporter.reset();
});

function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("end-to-end smoke", () => {
  it("emits a clean trace for a session + run + chat + tool sequence", async () => {
    const hookState = createWeaveHookState();
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "test-entity", project: "test-project", apiKey: "k", captureContent: true, agentName: "test-agent" },
      hookState,
    });
    await plugin.service.start({ logger: makeLogger(), config: {} } as any);

    const hooks = plugin.handlers.hook;
    const emit = plugin.handlers.diagnostic!;

    hooks.session_start!({ sessionKey: "s-1" });
    emit({ type: "run.started", ts: 1000, runId: "r-1", sessionKey: "s-1", trace: { traceId: "t", spanId: "sp" } }, { trusted: true });
    hooks.model_call_started!({ runId: "r-1", callId: "c-1" });
    emit({ type: "model.call.started", ts: 1100, runId: "r-1", callId: "c-1", model: "gpt-4o", trace: { traceId: "t", spanId: "csp", parentSpanId: "sp" } }, { trusted: true });
    hooks.llm_input!({ runId: "r-1", prompt: "hi", systemPrompt: "be helpful" });
    hooks.before_tool_call!({ runId: "r-1", toolCallId: "tc-1", toolName: "search", params: { q: "weave" } });
    emit({ type: "tool.execution.started", ts: 1200, runId: "r-1", toolCallId: "tc-1", toolName: "search", trace: { traceId: "t", spanId: "tcsp", parentSpanId: "csp" } }, { trusted: true });
    hooks.after_tool_call!({ runId: "r-1", toolCallId: "tc-1", result: { hits: 7 } });
    emit({ type: "tool.execution.completed", ts: 1300, runId: "r-1", toolCallId: "tc-1", trace: { traceId: "t", spanId: "tcsp" } }, { trusted: true });
    hooks.llm_output!({ runId: "r-1", assistantTexts: ["found 7"], usage: { input: 5, output: 3 } });
    emit({ type: "model.call.completed", ts: 1400, runId: "r-1", callId: "c-1", trace: { traceId: "t", spanId: "csp" } }, { trusted: true });
    emit({ type: "model.usage", ts: 1450, runId: "r-1", costUsd: 0.0001, trace: { traceId: "t", spanId: "sp" } }, { trusted: true });
    emit({ type: "run.completed", ts: 1500, runId: "r-1", sessionKey: "s-1", trace: { traceId: "t", spanId: "sp" }, outcome: "completed" }, { trusted: true });
    hooks.session_end!({ sessionKey: "s-1" });

    await plugin.service.stop({ logger: makeLogger() } as any);

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "invoke_agent" && s.attributes["weave.cost.usd"] !== undefined);
    const chat = spans.find((s) => s.name === "chat");
    const tool = spans.find((s) => s.name === "execute_tool");

    expect(turn).toBeDefined();
    expect(chat).toBeDefined();
    expect(tool).toBeDefined();

    expect(chat?.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(chat?.attributes["gen_ai.usage.input_tokens"]).toBe(5);
    expect(chat?.attributes["gen_ai.usage.output_tokens"]).toBe(3);

    expect(tool?.attributes["gen_ai.tool.name"]).toBe("search");
    expect(tool?.attributes["gen_ai.tool.call.id"]).toBe("tc-1");
    expect(tool?.attributes["gen_ai.tool.call.arguments"]).toBe('{"q":"weave"}');
    expect(tool?.attributes["gen_ai.tool.call.result"]).toBe('{"hits":7}');

    expect(turn?.attributes["weave.cost.usd"]).toBeCloseTo(0.0001);
    expect(turn?.attributes["gen_ai.agent.name"]).toBeDefined();

    expect(chat?.attributes["gen_ai.input.messages"]).toContain('"hi"');
    expect(chat?.attributes["gen_ai.output.messages"]).toContain('"found 7"');
  });

  // Real attempt shape: one llm_input, then model -> tool -> model, then one
  // llm_output with both texts; each model call gets its own chat span.
  it("multi-model-call attempt: both chat spans get their content", async () => {
    const hookState = createWeaveHookState();
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "test-entity", project: "test-project", apiKey: "k", captureContent: true, agentName: "test-agent" },
      hookState,
    });
    await plugin.service.start({ logger: makeLogger(), config: {} } as any);
    const hooks = plugin.handlers.hook;
    const emit = plugin.handlers.diagnostic!;

    hooks.session_start!({ sessionKey: "s-2" });
    emit({ type: "run.started", ts: 1000, runId: "r-2", sessionKey: "s-2", trace: { traceId: "tt", spanId: "sp2" } }, { trusted: true });
    hooks.llm_input!({ runId: "r-2", prompt: "find tennis stats", systemPrompt: "be brief" });
    hooks.model_call_started!({ runId: "r-2", callId: "c-A" });
    emit({ type: "model.call.started", ts: 1100, runId: "r-2", callId: "c-A", model: "gpt-4o", trace: { traceId: "tt", spanId: "csp-A", parentSpanId: "sp2" } }, { trusted: true });
    emit({ type: "model.call.completed", ts: 1200, runId: "r-2", callId: "c-A", trace: { traceId: "tt", spanId: "csp-A" } }, { trusted: true });
    hooks.before_tool_call!({ runId: "r-2", toolCallId: "tc-A", toolName: "search", params: { q: "tennis" } });
    emit({ type: "tool.execution.started", ts: 1250, runId: "r-2", toolCallId: "tc-A", toolName: "search", trace: { traceId: "tt", spanId: "tsp-A", parentSpanId: "sp2" } }, { trusted: true });
    hooks.after_tool_call!({ runId: "r-2", toolCallId: "tc-A", result: { hits: 3 } });
    emit({ type: "tool.execution.completed", ts: 1300, runId: "r-2", toolCallId: "tc-A", trace: { traceId: "tt", spanId: "tsp-A" } }, { trusted: true });
    hooks.model_call_started!({ runId: "r-2", callId: "c-B" });
    emit({ type: "model.call.started", ts: 1400, runId: "r-2", callId: "c-B", model: "gpt-4o", trace: { traceId: "tt", spanId: "csp-B", parentSpanId: "sp2" } }, { trusted: true });
    emit({ type: "model.call.completed", ts: 1500, runId: "r-2", callId: "c-B", trace: { traceId: "tt", spanId: "csp-B" } }, { trusted: true });
    hooks.llm_output!({ runId: "r-2", assistantTexts: ["I'll search", "Found 3 results"], usage: { input: 12, output: 8 } });
    emit({ type: "run.completed", ts: 1600, runId: "r-2", sessionKey: "s-2", trace: { traceId: "tt", spanId: "sp2" }, outcome: "completed" }, { trusted: true });
    hooks.session_end!({ sessionKey: "s-2" });

    await plugin.service.stop({ logger: makeLogger() } as any);

    const chats = exporter.getFinishedSpans().filter((s) => s.name === "chat");
    expect(chats.length).toBe(2);
    const outputs = chats.map((s) => String(s.attributes["gen_ai.output.messages"] ?? ""));
    expect(outputs[0]).toContain("I'll search");
    expect(outputs[1]).toContain("Found 3 results");
    // Only the first call has captured input (buffered llm_input, promoted once).
    const inputs = chats.map((s) => String(s.attributes["gen_ai.input.messages"] ?? ""));
    expect(inputs[0]).toContain("find tennis stats");
    const usageBearer = chats.find((s) => s.attributes["gen_ai.usage.input_tokens"] !== undefined);
    expect(usageBearer?.attributes["gen_ai.usage.input_tokens"]).toBe(12);
    expect(usageBearer?.attributes["gen_ai.usage.output_tokens"]).toBe(8);
  });
});
