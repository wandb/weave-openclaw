// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { describe, it, expect, beforeEach } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { init as weaveInit, getWeaveTracer } from "weave";
import { createWeavePlugin } from "./plugin.js";
import { createWeaveHookState } from "./state/hook-state.js";

const exporter = new InMemorySpanExporter();

beforeEach(async () => {
  exporter.reset();
  process.env.WANDB_API_KEY = "test";
  await weaveInit("rgao/test", {
    genai: { spanProcessor: new SimpleSpanProcessor(exporter) },
  });
  // Warmup forces the SDK's lazy provider build to pin our
  // SimpleSpanProcessor as the active span processor. Without this,
  // the plugin's later weaveInit() inside service.start() builds a
  // fresh provider WITHOUT our exporter, and tests see 0 spans
  // with no error. The warmup span itself is discarded via reset().
  getWeaveTracer("warmup").startSpan("warmup").end();
  exporter.reset();
});

function makeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

describe("end-to-end smoke", () => {
  it("emits a clean trace for a session + run + chat + tool sequence", async () => {
    const hookState = createWeaveHookState();
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "rgao", project: "test", apiKey: "k", captureContent: true, agentName: "test-agent" },
      hookState,
    });
    await plugin.service.start({ logger: makeLogger() } as any);

    const h = plugin.handlers.hook;
    const d = plugin.handlers.diagnostic!;

    h.session_start!({ sessionKey: "s-1" });
    d({
      type: "run.started",
      ts: 1000,
      runId: "r-1",
      sessionKey: "s-1",
      trace: { traceId: "t", spanId: "sp" },
    }, { trusted: true });
    h.model_call_started!({ runId: "r-1", callId: "c-1" });
    d({
      type: "model.call.started",
      ts: 1100,
      runId: "r-1",
      callId: "c-1",
      model: "gpt-4o",
      trace: { traceId: "t", spanId: "csp", parentSpanId: "sp" },
    }, { trusted: true });
    h.llm_input!({ runId: "r-1", prompt: "hi", systemPrompt: "be helpful" });
    h.before_tool_call!({
      runId: "r-1",
      toolCallId: "tc-1",
      toolName: "search",
      params: { q: "weave" },
    });
    d({
      type: "tool.execution.started",
      ts: 1200,
      runId: "r-1",
      toolCallId: "tc-1",
      toolName: "search",
      trace: { traceId: "t", spanId: "tcsp", parentSpanId: "csp" },
    }, { trusted: true });
    h.after_tool_call!({ runId: "r-1", toolCallId: "tc-1", result: { hits: 7 } });
    d({
      type: "tool.execution.completed",
      ts: 1300,
      runId: "r-1",
      toolCallId: "tc-1",
      trace: { traceId: "t", spanId: "tcsp" },
    }, { trusted: true });
    h.llm_output!({
      runId: "r-1",
      assistantTexts: ["found 7"],
      usage: { input: 5, output: 3 },
    });
    d({
      type: "model.call.completed",
      ts: 1400,
      runId: "r-1",
      callId: "c-1",
      trace: { traceId: "t", spanId: "csp" },
    }, { trusted: true });
    d({
      type: "model.usage",
      ts: 1450,
      runId: "r-1",
      costUsd: 0.0001,
      trace: { traceId: "t", spanId: "sp" },
    }, { trusted: true });
    d({
      type: "run.completed",
      ts: 1500,
      runId: "r-1",
      sessionKey: "s-1",
      trace: { traceId: "t", spanId: "sp" },
      outcome: "completed",
    }, { trusted: true });
    h.session_end!({ sessionKey: "s-1" });

    await plugin.service.stop({ logger: makeLogger() } as any);

    const spans = exporter.getFinishedSpans();
    // Turn (invoke_agent) — there should be exactly one for the agent run.
    const turn = spans.find(
      (s) => s.name === "invoke_agent" && s.attributes["weave.cost.usd"] !== undefined,
    );
    const chat = spans.find((s) => s.name === "chat");
    const tool = spans.find((s) => s.name === "execute_tool");

    expect(turn).toBeDefined();
    expect(chat).toBeDefined();
    expect(tool).toBeDefined();

    // Chat: gen_ai.* attrs from the SDK.
    expect(chat?.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(chat?.attributes["gen_ai.usage.input_tokens"]).toBe(5);
    expect(chat?.attributes["gen_ai.usage.output_tokens"]).toBe(3);

    // Tool: gen_ai.* attrs from the SDK.
    expect(tool?.attributes["gen_ai.tool.name"]).toBe("search");
    expect(tool?.attributes["gen_ai.tool.call.id"]).toBe("tc-1");
    expect(tool?.attributes["gen_ai.tool.call.arguments"]).toBe('{"q":"weave"}');
    expect(tool?.attributes["gen_ai.tool.call.result"]).toBe('{"hits":7}');

    // Turn: side-channel cost stamped via Turn.setAttribute.
    expect(turn?.attributes["weave.cost.usd"]).toBeCloseTo(0.0001);
    expect(turn?.attributes["gen_ai.agent.name"]).toBeDefined();

    // Chat content: with captureContent=true, the prompt+system end up in
    // input.messages and the assistantTexts in output.messages.
    expect(chat?.attributes["gen_ai.input.messages"]).toContain('"hi"');
    expect(chat?.attributes["gen_ai.output.messages"]).toContain('"found 7"');
  });

  // Mirrors OpenClaw's real-world multi-model-call attempt shape: ONE
  // llm_input fires at the start, then `model→tool→model`, then ONE
  // llm_output at the end carrying both assistant texts. The plugin must
  // emit a chat span for EACH model call with content attributed
  // positionally — not just close the last one.
  it("multi-model-call attempt: both chat spans get their content", async () => {
    const hookState = createWeaveHookState();
    const plugin = createWeavePlugin({
      pluginConfig: { entity: "rgao", project: "test", apiKey: "k", captureContent: true, agentName: "test-agent" },
      hookState,
    });
    await plugin.service.start({ logger: makeLogger() } as any);
    const h = plugin.handlers.hook;
    const d = plugin.handlers.diagnostic!;

    h.session_start!({ sessionKey: "s-2" });
    d({ type: "run.started", ts: 1000, runId: "r-2", sessionKey: "s-2",
        trace: { traceId: "tt", spanId: "sp2" } }, { trusted: true });
    // llm_input fires ONCE, before model_call_started (real OpenClaw order).
    h.llm_input!({ runId: "r-2", prompt: "find tennis stats", systemPrompt: "be brief" });
    // First model call: model:1 -> emits "I'll search" + a tool call.
    h.model_call_started!({ runId: "r-2", callId: "c-A" });
    d({ type: "model.call.started", ts: 1100, runId: "r-2", callId: "c-A", model: "gpt-4o",
        trace: { traceId: "tt", spanId: "csp-A", parentSpanId: "sp2" } }, { trusted: true });
    d({ type: "model.call.completed", ts: 1200, runId: "r-2", callId: "c-A",
        trace: { traceId: "tt", spanId: "csp-A" } }, { trusted: true });
    // Tool runs between the two model calls.
    h.before_tool_call!({ runId: "r-2", toolCallId: "tc-A", toolName: "search", params: { q: "tennis" } });
    d({ type: "tool.execution.started", ts: 1250, runId: "r-2", toolCallId: "tc-A", toolName: "search",
        trace: { traceId: "tt", spanId: "tsp-A", parentSpanId: "sp2" } }, { trusted: true });
    h.after_tool_call!({ runId: "r-2", toolCallId: "tc-A", result: { hits: 3 } });
    d({ type: "tool.execution.completed", ts: 1300, runId: "r-2", toolCallId: "tc-A",
        trace: { traceId: "tt", spanId: "tsp-A" } }, { trusted: true });
    // Second model call: model:2 -> final answer.
    h.model_call_started!({ runId: "r-2", callId: "c-B" });
    d({ type: "model.call.started", ts: 1400, runId: "r-2", callId: "c-B", model: "gpt-4o",
        trace: { traceId: "tt", spanId: "csp-B", parentSpanId: "sp2" } }, { trusted: true });
    d({ type: "model.call.completed", ts: 1500, runId: "r-2", callId: "c-B",
        trace: { traceId: "tt", spanId: "csp-B" } }, { trusted: true });
    // llm_output fires ONCE at end of attempt with BOTH texts.
    h.llm_output!({
      runId: "r-2",
      assistantTexts: ["I'll search", "Found 3 results"],
      usage: { input: 12, output: 8 },
    });
    d({ type: "run.completed", ts: 1600, runId: "r-2", sessionKey: "s-2",
        trace: { traceId: "tt", spanId: "sp2" }, outcome: "completed" }, { trusted: true });
    h.session_end!({ sessionKey: "s-2" });

    await plugin.service.stop({ logger: makeLogger() } as any);

    const spans = exporter.getFinishedSpans();
    const chats = spans.filter((s) => s.name === "chat");
    expect(chats.length).toBe(2);
    const outputs = chats.map((s) => String(s.attributes["gen_ai.output.messages"] ?? ""));
    // Position 0 (first chat) gets the first assistant text; position 1 the second.
    expect(outputs[0]).toContain("I'll search");
    expect(outputs[1]).toContain("Found 3 results");
    // Only the FIRST call has captured input (llm_input is buffered then promoted by
    // the first model_call_started; subsequent calls have no prompt buffer).
    const inputs = chats.map((s) => String(s.attributes["gen_ai.input.messages"] ?? ""));
    expect(inputs[0]).toContain("find tennis stats");
    // Usage is attached to the LAST chat span (llm_output's cumulative usage).
    const usageBearer = chats.find((s) => s.attributes["gen_ai.usage.input_tokens"] !== undefined);
    expect(usageBearer).toBeDefined();
    expect(usageBearer?.attributes["gen_ai.usage.input_tokens"]).toBe(12);
    expect(usageBearer?.attributes["gen_ai.usage.output_tokens"]).toBe(8);
  });
});
