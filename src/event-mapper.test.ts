import { SpanKind } from "@opentelemetry/api";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { describe, expect, it, test } from "vitest";
import { mapDiagnosticEventToWeaveSpan, stripWrapperPrefix } from "./event-mapper.js";
import { createWeaveHookState } from "./hook-state.js";
import { NO_CONTENT_CAPTURE, type ResolvedWeavePluginConfig } from "./types.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const ROOT_SPAN_ID = "1111111111111111";
const CHILD_SPAN_ID = "2222222222222222";

const baseCfg: ResolvedWeavePluginConfig = {
  entity: "acme",
  project: "agents",
  endpoint: "https://trace.wandb.ai/agents/otel/v1/traces",
  serviceName: "openclaw-agent",
  captureContent: NO_CONTENT_CAPTURE,
  flushIntervalMs: 5000,
  stripSenderWrapper: false,
  emitGenAiAliases: false,
};

function trace(spanId: string, parentSpanId?: string) {
  return {
    traceId: TRACE_ID,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    traceFlags: "01",
  };
}

describe("mapDiagnosticEventToWeaveSpan", () => {
  test("skips events without trace context", () => {
    const event = {
      type: "run.started",
      ts: 1000,
      seq: 1,
      runId: "r-1",
      harnessId: "h-1",
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    expect(r.kind).toBe("skip");
  });

  test("run.started carries full agent + conversation + provider attrs", () => {
    const event = {
      type: "run.started",
      ts: 1000,
      seq: 1,
      runId: "r-1",
      harnessId: "research-assistant",
      pluginId: "openai",
      sessionKey: "conv-abc",
      provider: "openai",
      model: "gpt-5.4",
      trace: trace(ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;

    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    expect(r.kind).toBe("start");
    if (r.kind !== "start") return;

    expect(r.spanName).toBe("invoke_agent research-assistant");
    expect(r.spanKind).toBe(SpanKind.INTERNAL);
    expect(r.openclawSpanId).toBe(ROOT_SPAN_ID);
    expect(r.openclawParentSpanId).toBeUndefined();
    expect(r.attrs["weave.operation.name"]).toBe("invoke_agent");
    expect(r.attrs["weave.agent.name"]).toBe("research-assistant");
    expect(r.attrs["weave.conversation.id"]).toBe("conv-abc");
    expect(r.attrs["weave.provider.name"]).toBe("openai");
    expect(r.attrs["weave.request.model"]).toBe("gpt-5.4");
  });

  test("agentName from cfg overrides harnessId", () => {
    const cfg: ResolvedWeavePluginConfig = { ...baseCfg, agentName: "code-reviewer" };
    const event = {
      type: "run.started",
      ts: 1,
      seq: 1,
      runId: "r-1",
      harnessId: "should-be-ignored",
      trace: trace(ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg);
    if (r.kind !== "start") throw new Error("expected start");
    expect(r.spanName).toBe("invoke_agent code-reviewer");
    expect(r.attrs["weave.agent.name"]).toBe("code-reviewer");
  });

  test("model.call.started -> chat <model> with parent", () => {
    const event = {
      type: "model.call.started",
      ts: 1100,
      seq: 2,
      runId: "r-1",
      callId: "c-1",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      sessionKey: "conv-abc",
      trace: trace(CHILD_SPAN_ID, ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;

    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "start") throw new Error("expected start");
    expect(r.spanName).toBe("chat claude-sonnet-4.6");
    expect(r.spanKind).toBe(SpanKind.CLIENT);
    expect(r.openclawSpanId).toBe(CHILD_SPAN_ID);
    expect(r.openclawParentSpanId).toBe(ROOT_SPAN_ID);
    expect(r.attrs["weave.operation.name"]).toBe("chat");
    expect(r.attrs["weave.provider.name"]).toBe("anthropic");
    expect(r.attrs["weave.request.model"]).toBe("claude-sonnet-4.6");
  });

  test("model.call.completed finalizes with usage tokens", () => {
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 200,
      usage: { input: 150, output: 40, cacheRead: 30, cacheWrite: 20 },
      responseId: "resp_abc123",
      trace: trace(CHILD_SPAN_ID, ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;

    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.openclawSpanId).toBe(CHILD_SPAN_ID);
    expect(r.status).toBe("ok");
    expect(r.attrs["weave.usage.input_tokens"]).toBe(150);
    expect(r.attrs["weave.usage.output_tokens"]).toBe(40);
    expect(r.attrs["weave.response.id"]).toBe("resp_abc123");
    expect(r.attrs["weave.response.model"]).toBe("gpt-5.4");
  });

  test("finalizeChat emits weave.latency.time_to_first_byte_ms when payload carries timeToFirstByteMs", () => {
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 200,
      timeToFirstByteMs: 73,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.attrs["weave.latency.time_to_first_byte_ms"]).toBe(73);
  });

  test("finalizeChat omits TTFB attr when timeToFirstByteMs is absent", () => {
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.attrs["weave.latency.time_to_first_byte_ms"]).toBeUndefined();
  });

  test("model.call.completed without usage object falls back to flat fields", () => {
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 200,
      inputTokens: 80,
      outputTokens: 25,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.attrs["weave.usage.input_tokens"]).toBe(80);
    expect(r.attrs["weave.usage.output_tokens"]).toBe(25);
  });

  test("model.call.error finalizes with error.type", () => {
    const event = {
      type: "model.call.error",
      ts: 2500,
      seq: 8,
      runId: "r-1",
      callId: "c-1",
      provider: "google",
      model: "gemini-2.5-flash",
      durationMs: 1250,
      errorCategory: "TimeoutError",
      failureKind: "timeout",
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.status).toBe("error");
    expect(r.errorType).toBe("TimeoutError");
    expect(r.attrs["error.type"]).toBe("TimeoutError");
    expect(r.attrs["weave.failure.kind"]).toBe("timeout");
  });

  test("tool.execution.started -> execute_tool <name>", () => {
    const event = {
      type: "tool.execution.started",
      ts: 1500,
      seq: 4,
      runId: "r-1",
      toolName: "search_web",
      toolCallId: "call_xyz",
      sessionKey: "conv-abc",
      trace: trace("3333333333333333", CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "start") throw new Error("expected start");
    expect(r.spanName).toBe("execute_tool search_web");
    expect(r.spanKind).toBe(SpanKind.INTERNAL);
    expect(r.attrs["weave.operation.name"]).toBe("execute_tool");
    expect(r.attrs["weave.tool.name"]).toBe("search_web");
    expect(r.attrs["weave.tool.call.id"]).toBe("call_xyz");
    expect(r.attrs["weave.conversation.id"]).toBe("conv-abc");
  });

  test("tool.execution.completed -> finalize ok", () => {
    const event = {
      type: "tool.execution.completed",
      ts: 1700,
      seq: 6,
      runId: "r-1",
      toolName: "search_web",
      toolCallId: "call_xyz",
      durationMs: 200,
      trace: trace("3333333333333333", CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.openclawSpanId).toBe("3333333333333333");
    expect(r.status).toBe("ok");
    expect(r.errorType).toBeUndefined();
  });

  test("tool.execution.completed with captureContent emits weave.tool.call.result", () => {
    const cfg: ResolvedWeavePluginConfig = {
      ...baseCfg,
      captureContent: {
        enabled: true,
        inputMessages: false,
        outputMessages: false,
        toolArguments: false,
        toolResults: true,
        systemInstructions: false,
      },
    };
    const event = {
      type: "tool.execution.completed",
      ts: 1700,
      seq: 6,
      runId: "r-1",
      toolName: "search_web",
      toolCallId: "call_xyz",
      durationMs: 200,
      toolOutput: { rows: 3, status: "ok" },
      trace: trace("3333333333333333", CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(typeof r.attrs["weave.tool.call.result"]).toBe("string");
    const parsed = JSON.parse(String(r.attrs["weave.tool.call.result"]));
    expect(parsed.status).toBe("ok");
  });

  test("tool.execution.blocked -> finalize error with denied reason as errorType", () => {
    const event = {
      type: "tool.execution.blocked",
      ts: 1600,
      seq: 5,
      runId: "r-1",
      toolName: "send_email",
      deniedReason: "policy:no_external_email",
      reason: "policy",
      trace: trace("3333333333333333", CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.status).toBe("error");
    // deniedReason is the rich, user-facing value — should drive errorType so
    // the Agents tab error column shows actionable detail.
    expect(r.errorType).toBe("policy:no_external_email");
    expect(r.attrs["error.type"]).toBe("policy:no_external_email");
    expect(r.attrs["weave.tool.denied_reason"]).toBe("policy:no_external_email");
    // The short `reason` is preserved as a separate attribute when distinct.
    expect(r.attrs["weave.tool.block.reason"]).toBe("policy");
  });

  test("tool.execution.blocked falls back to 'blocked' when neither field is present", () => {
    const event = {
      type: "tool.execution.blocked",
      ts: 1600,
      seq: 5,
      runId: "r-1",
      toolName: "send_email",
      trace: trace("3333333333333333", CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.errorType).toBe("blocked");
  });

  test("captureContent off does NOT emit weave.input.messages even if payload has it", () => {
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 200,
      inputMessages: [{ role: "user", content: "hi" }],
      outputMessages: [{ role: "assistant", content: "hello" }],
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.attrs["weave.input.messages"]).toBeUndefined();
    expect(r.attrs["weave.output.messages"]).toBeUndefined();
  });

  test("input messages truncation flag is set when serialized content exceeds MAX_ATTRIBUTE_CHARS (256 KiB)", () => {
    const huge = "x".repeat(400_000); // 400 KiB > 256 KiB clamp
    const cfg: ResolvedWeavePluginConfig = {
      ...baseCfg,
      captureContent: {
        enabled: true,
        inputMessages: true,
        outputMessages: false,
        toolArguments: false,
        toolResults: false,
        systemInstructions: false,
      },
    };
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 200,
      inputMessages: [{ role: "user", content: huge }],
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.attrs["weave.input.messages_truncated"]).toBe(true);
    expect(typeof r.attrs["weave.input.messages"]).toBe("string");
  });

  test("captureContent on emits weave.input.messages and weave.output.messages", () => {
    const cfg: ResolvedWeavePluginConfig = {
      ...baseCfg,
      captureContent: {
        enabled: true,
        inputMessages: true,
        outputMessages: true,
        toolArguments: false,
        toolResults: false,
        systemInstructions: false,
      },
    };
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 200,
      inputMessages: [{ role: "user", content: "summarize this" }],
      outputMessages: [{ role: "assistant", content: "Sure: ..." }],
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(typeof r.attrs["weave.input.messages"]).toBe("string");
    expect(typeof r.attrs["weave.output.messages"]).toBe("string");
    const parsed = JSON.parse(String(r.attrs["weave.input.messages"]));
    expect(parsed[0]?.role).toBe("user");
  });

  test("run.completed with outcome=error preserves errorCategory as errorType + weave.outcome attr", () => {
    const event = {
      type: "run.completed",
      ts: 3000,
      seq: 9,
      runId: "r-1",
      harnessId: "h",
      durationMs: 100,
      outcome: "error",
      errorCategory: "ProviderTimeout",
      trace: trace(ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.status).toBe("error");
    expect(r.errorType).toBe("ProviderTimeout");
    expect(r.attrs["weave.outcome"]).toBe("error");
  });

  test("run.completed with outcome=aborted finalizes ERROR with outcome as fallback errorType", () => {
    const event = {
      type: "run.completed",
      ts: 3000,
      seq: 9,
      runId: "r-1",
      harnessId: "h",
      durationMs: 100,
      outcome: "aborted",
      trace: trace(ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.status).toBe("error");
    expect(r.errorType).toBe("aborted");
  });

  test("run.started -> invoke_agent start span (run.* is canonical root)", () => {
    const event = {
      type: "run.started",
      ts: 1000,
      seq: 1,
      runId: "r-1",
      harnessId: "research-assistant",
      sessionKey: "conv-abc",
      provider: "openai",
      model: "gpt-5.4",
      trace: trace(ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    expect(r.kind).toBe("start");
    if (r.kind !== "start") return;
    expect(r.spanName).toBe("invoke_agent research-assistant");
    expect(r.spanKind).toBe(SpanKind.INTERNAL);
    expect(r.openclawSpanId).toBe(ROOT_SPAN_ID);
    expect(r.attrs["weave.operation.name"]).toBe("invoke_agent");
  });

  test("run.completed with outcome=completed -> finalize ok", () => {
    const event = {
      type: "run.completed",
      ts: 2000,
      seq: 2,
      runId: "r-1",
      durationMs: 1000,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    expect(r.kind).toBe("finalize");
    if (r.kind !== "finalize") return;
    expect(r.openclawSpanId).toBe(ROOT_SPAN_ID);
    expect(r.status).toBe("ok");
  });

  test("run.completed with outcome=error -> finalize error", () => {
    const event = {
      type: "run.completed",
      ts: 2000,
      seq: 2,
      runId: "r-1",
      durationMs: 1000,
      outcome: "error",
      errorCategory: "ProviderTimeout",
      trace: trace(ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    expect(r.kind).toBe("finalize");
    if (r.kind !== "finalize") return;
    expect(r.status).toBe("error");
    expect(r.errorType).toBe("ProviderTimeout");
  });

  test("harness.run.* events are NOT mapped (run.* is canonical, harness.run.* has divergent spanIds)", () => {
    // The OpenClaw runtime emits harness.run.started without an explicit trace
    // context (auto-generated spanId X1) but emits harness.run.completed with
    // result.diagnosticTrace (different spanId X2). This breaks span correlation
    // by spanId. The plugin uses run.started/run.completed instead — these
    // share spanId because pi-embedded-runner threads diagnosticRunBase
    // through both emits. See src/event-mapper.ts header comment.
    const startEvent = {
      type: "harness.run.started",
      ts: 1000,
      seq: 1,
      runId: "r-1",
      harnessId: "h-1",
      trace: trace(ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    expect(mapDiagnosticEventToWeaveSpan(startEvent, baseCfg).kind).toBe("skip");
    const completeEvent = {
      type: "harness.run.completed",
      ts: 2000,
      seq: 9,
      runId: "r-1",
      harnessId: "h-1",
      durationMs: 1000,
      outcome: "completed",
      trace: trace("4444444444444444"),
    } as unknown as DiagnosticEventPayload;
    expect(mapDiagnosticEventToWeaveSpan(completeEvent, baseCfg).kind).toBe("skip");
    const errorEvent = {
      type: "harness.run.error",
      ts: 2000,
      seq: 9,
      runId: "r-1",
      harnessId: "h-1",
      durationMs: 1000,
      phase: "send",
      errorCategory: "ProviderTimeout",
      trace: trace("4444444444444444"),
    } as unknown as DiagnosticEventPayload;
    expect(mapDiagnosticEventToWeaveSpan(errorEvent, baseCfg).kind).toBe("skip");
  });

  test("model.call.started emits sampling parameters when payload carries them", () => {
    const event = {
      type: "model.call.started",
      ts: 1100,
      seq: 2,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      sessionKey: "conv-abc",
      temperature: 0.7,
      topP: 0.95,
      maxTokens: 1024,
      seed: 42,
      stopSequences: ["END", "STOP"],
      frequencyPenalty: 0.5,
      presencePenalty: 0.1,
      trace: trace(CHILD_SPAN_ID, ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "start") throw new Error("expected start");
    expect(r.attrs["weave.request.temperature"]).toBe(0.7);
    expect(r.attrs["weave.request.top_p"]).toBe(0.95);
    expect(r.attrs["weave.request.max_tokens"]).toBe(1024);
    expect(r.attrs["weave.request.seed"]).toBe(42);
    expect(r.attrs["weave.request.frequency_penalty"]).toBe(0.5);
    expect(r.attrs["weave.request.presence_penalty"]).toBe(0.1);
    expect(JSON.parse(String(r.attrs["weave.request.stop_sequences"]))).toEqual([
      "END",
      "STOP",
    ]);
  });

  test("finalizeChat emits weave.usage.reasoning_tokens from hook usage payload", () => {
    const cfg: ResolvedWeavePluginConfig = baseCfg;
    const hookState = createWeaveHookState();
    hookState.currentCallByRun.set("r-1", "c-1");
    hookState.llmOutputs.set("c-1", {
      assistantTexts: ["answer"],
      usage: { input: 100, output: 50, reasoning: 1024 },
    });
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg, { hookState });
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.attrs["weave.usage.reasoning_tokens"]).toBe(1024);
  });

  test("finalizeChat emits weave.reasoning_content from Anthropic thinking blocks", () => {
    const cfg: ResolvedWeavePluginConfig = {
      ...baseCfg,
      captureContent: {
        enabled: true,
        inputMessages: false,
        outputMessages: false,
        toolArguments: false,
        toolResults: false,
        systemInstructions: false,
      },
    };
    const hookState = createWeaveHookState();
    hookState.currentCallByRun.set("r-1", "c-1");
    hookState.llmOutputs.set("c-1", {
      assistantTexts: ["final answer"],
      lastAssistant: {
        content: [
          { type: "thinking", thinking: "Let me work through this step by step..." },
          { type: "text", text: "final answer" },
        ],
      },
    });
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "anthropic",
      model: "claude-opus-4.6",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg, { hookState });
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.attrs["weave.reasoning_content"]).toContain("step by step");
  });

  test("finalizeChat detects weave.output.type=image when lastAssistant has image part", () => {
    const cfg: ResolvedWeavePluginConfig = baseCfg;
    const hookState = createWeaveHookState();
    hookState.currentCallByRun.set("r-1", "c-1");
    hookState.llmOutputs.set("c-1", {
      assistantTexts: ["here's the chart"],
      lastAssistant: {
        content: [
          { type: "text", text: "here's the chart" },
          { type: "image", source: { data: "base64..." } },
        ],
      },
    });
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "anthropic",
      model: "claude-opus-4.6",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg, { hookState });
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.attrs["weave.output.type"]).toBe("image");
  });

  test("finalizeChat omits weave.output.type when no lastAssistant payload", () => {
    // Per OTel semconv `gen_ai.output.type` is "Conditionally Required";
    // omitting when modality is unknown is canonical and avoids polluting
    // the modality filter with empty-string sentinels.
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.attrs["weave.output.type"]).toBeUndefined();
    expect(r.attrs["gen_ai.output.type"]).toBeUndefined();
  });

  test("weave.agent.id is a stable 8-char hex hash", () => {
    const event = {
      type: "run.started",
      ts: 1000,
      seq: 1,
      runId: "r-1",
      harnessId: "research-assistant",
      sessionKey: "conv-abc",
      trace: trace(ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r.kind !== "start") throw new Error("expected start");
    expect(String(r.attrs["weave.agent.id"])).toMatch(/^[0-9a-f]{8}$/);
    // Same harnessId + entity + project produces the same hash.
    const r2 = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    if (r2.kind !== "start") throw new Error("expected start");
    expect(r2.attrs["weave.agent.id"]).toBe(r.attrs["weave.agent.id"]);
  });

  test("unmapped event types skip", () => {
    const event = {
      type: "session.state",
      ts: 5,
      seq: 1,
      state: "idle",
      trace: trace(ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, baseCfg);
    expect(r.kind).toBe("skip");
  });
});

describe("mapDiagnosticEventToWeaveSpan — OTel conformance", () => {
  function captureCfg(): ResolvedWeavePluginConfig {
    return {
      ...baseCfg,
      captureContent: {
        enabled: true,
        inputMessages: true,
        outputMessages: true,
        toolArguments: true,
        toolResults: true,
        systemInstructions: true,
      },
    };
  }

  test("history role 'toolResult' is normalized to OTel canonical 'tool'", () => {
    // pi-ai's `ToolResultMessage` has role "toolResult"; OTel/OpenAI canonical
    // is "tool". Without normalization, Weave's chat view shows a
    // non-standard role and downstream OTel consumers (Datadog etc.) treat
    // the message as untyped.
    const cfg = captureCfg();
    const hookState = createWeaveHookState();
    hookState.currentCallByRun.set("r-1", "c-1");
    hookState.llmInputs.set("c-1", {
      systemPrompt: "sys",
      prompt: "follow-up",
      historyMessages: [
        { role: "user", content: "what's the weather?" },
        {
          role: "toolResult",
          toolCallId: "call_abc",
          toolName: "get_weather",
          content: "72F sunny",
          isError: false,
        },
        { role: "assistant", content: "It's 72F and sunny." },
      ],
    });
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg, { hookState });
    if (r.kind !== "finalize") throw new Error("expected finalize");
    const messages = JSON.parse(String(r.attrs["weave.input.messages"]));
    const roles = messages.map((m: { role: string }) => m.role);
    expect(roles).toContain("tool");
    expect(roles).not.toContain("toolResult");
    // Tool message has OTel-canonical tool_call_response part.
    const toolMsg = messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMsg.parts?.[0]?.type).toBe("tool_call_response");
    expect(toolMsg.parts?.[0]?.id).toBe("call_abc");
  });

  test("history role 'custom' with internal customType is filtered", () => {
    const cfg = captureCfg();
    const hookState = createWeaveHookState();
    hookState.currentCallByRun.set("r-1", "c-1");
    hookState.llmInputs.set("c-1", {
      systemPrompt: "sys",
      prompt: "do thing",
      historyMessages: [
        { role: "user", content: "hello" },
        // Internal scaffolding the model never saw as a distinct turn:
        {
          role: "custom",
          customType: "openclaw.runtime-context",
          content: "Per-turn runtime context blob",
        },
        {
          role: "custom",
          customType: "openclaw.cache-ttl",
          content: "cache marker",
        },
        {
          role: "custom",
          customType: "model-snapshot",
          content: "{snapshot}",
        },
        // Inbound metadata block from buildInboundUserContextPrefix:
        {
          role: "custom",
          content: "Conversation info (untrusted metadata):\n```json\n{}\n```",
        },
        {
          role: "custom",
          content: "Sender (untrusted metadata):\n```json\n{}\n```",
        },
        { role: "assistant", content: "ok" },
      ],
    });
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg, { hookState });
    if (r.kind !== "finalize") throw new Error("expected finalize");
    const messages = JSON.parse(String(r.attrs["weave.input.messages"]));
    // None of the filtered customs should appear.
    expect(messages.find((m: { role: string }) => m.role === "custom")).toBeUndefined();
    // user + assistant + final prompt user remain.
    const roles = messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  test("output messages emit OTel-canonical {type:'text'} parts", () => {
    const cfg = captureCfg();
    const hookState = createWeaveHookState();
    hookState.currentCallByRun.set("r-1", "c-1");
    hookState.llmOutputs.set("c-1", {
      assistantTexts: ["hello world"],
      lastAssistant: {
        content: [{ type: "text", text: "hello world" }],
        stop_reason: "end_turn",
      },
    });
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg, { hookState });
    if (r.kind !== "finalize") throw new Error("expected finalize");
    const out = JSON.parse(String(r.attrs["weave.output.messages"]));
    expect(out[0].role).toBe("assistant");
    expect(out[0].finish_reason).toBe("end_turn");
    expect(out[0].content).toBe("hello world");
    expect(out[0].parts).toEqual([{ type: "text", content: "hello world" }]);
  });

  test("output reasoning content surfaces as OTel ReasoningPart", () => {
    const cfg = captureCfg();
    const hookState = createWeaveHookState();
    hookState.currentCallByRun.set("r-1", "c-1");
    hookState.llmOutputs.set("c-1", {
      assistantTexts: ["The answer is 42."],
      lastAssistant: {
        content: [
          { type: "thinking", thinking: "Let me compute..." },
          { type: "text", text: "The answer is 42." },
        ],
        stop_reason: "end_turn",
      },
    });
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg, { hookState });
    if (r.kind !== "finalize") throw new Error("expected finalize");
    const out = JSON.parse(String(r.attrs["weave.output.messages"]));
    const types = out[0].parts.map((p: { type: string }) => p.type);
    expect(types).toContain("reasoning");
    expect(types).toContain("text");
    // Top-level reasoning_content also emitted for legacy dashboards.
    expect(r.attrs["weave.reasoning_content"]).toContain("Let me compute");
  });

  test("emits weave.response.finish_reasons as JSON-encoded string array", () => {
    const cfg = captureCfg();
    const hookState = createWeaveHookState();
    hookState.currentCallByRun.set("r-1", "c-1");
    hookState.llmOutputs.set("c-1", {
      assistantTexts: ["ok"],
      lastAssistant: { content: "ok", stop_reason: "stop" },
    });
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg, { hookState });
    if (r.kind !== "finalize") throw new Error("expected finalize");
    expect(r.attrs["weave.response.finish_reasons"]).toBe(
      JSON.stringify(["stop"]),
    );
  });

  test("system_instructions is emitted as a JSON-encoded list[str]", () => {
    const cfg = captureCfg();
    const hookState = createWeaveHookState();
    hookState.currentCallByRun.set("r-1", "c-1");
    hookState.llmInputs.set("c-1", {
      systemPrompt: "You are a helpful assistant.",
      prompt: "hi",
      historyMessages: [],
    });
    const event = {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg, { hookState });
    if (r.kind !== "finalize") throw new Error("expected finalize");
    const sys = String(r.attrs["weave.system_instructions"]);
    const parsed = JSON.parse(sys);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(["You are a helpful assistant."]);
  });

  test("emitGenAiAliases=true dual-emits gen_ai.* keys for aliased weave.* attrs", () => {
    const cfg: ResolvedWeavePluginConfig = { ...baseCfg, emitGenAiAliases: true };
    const event = {
      type: "model.call.started",
      ts: 1100,
      seq: 2,
      runId: "r-1",
      callId: "c-1",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      sessionKey: "conv-abc",
      temperature: 0.2,
      maxTokens: 4096,
      trace: trace(CHILD_SPAN_ID, ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg);
    if (r.kind !== "start") throw new Error("expected start");
    expect(r.attrs["weave.operation.name"]).toBe("chat");
    expect(r.attrs["gen_ai.operation.name"]).toBe("chat");
    expect(r.attrs["weave.provider.name"]).toBe("anthropic");
    expect(r.attrs["gen_ai.provider.name"]).toBe("anthropic");
    expect(r.attrs["weave.request.model"]).toBe("claude-sonnet-4.6");
    expect(r.attrs["gen_ai.request.model"]).toBe("claude-sonnet-4.6");
    expect(r.attrs["weave.conversation.id"]).toBe("conv-abc");
    expect(r.attrs["gen_ai.conversation.id"]).toBe("conv-abc");
    expect(r.attrs["weave.request.temperature"]).toBe(0.2);
    expect(r.attrs["gen_ai.request.temperature"]).toBe(0.2);
    expect(r.attrs["weave.request.max_tokens"]).toBe(4096);
    expect(r.attrs["gen_ai.request.max_tokens"]).toBe(4096);
  });

  test("emitGenAiAliases=false omits gen_ai.* aliases", () => {
    const cfg: ResolvedWeavePluginConfig = { ...baseCfg, emitGenAiAliases: false };
    const event = {
      type: "model.call.started",
      ts: 1100,
      seq: 2,
      runId: "r-1",
      callId: "c-1",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      sessionKey: "conv-abc",
      trace: trace(CHILD_SPAN_ID, ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg);
    if (r.kind !== "start") throw new Error("expected start");
    expect(r.attrs["weave.operation.name"]).toBe("chat");
    expect(r.attrs["gen_ai.operation.name"]).toBeUndefined();
    expect(r.attrs["gen_ai.provider.name"]).toBeUndefined();
  });

  test("alias dual-emit skips weave.* extensions with no gen_ai.* equivalent", () => {
    // weave.compaction.*, weave.outcome, weave.failure.*, weave.harness.*
    // are Weave-only extensions and have no canonical gen_ai.* counterpart.
    const cfg: ResolvedWeavePluginConfig = { ...baseCfg, emitGenAiAliases: true };
    const event = {
      type: "run.completed",
      ts: 3000,
      seq: 9,
      runId: "r-1",
      harnessId: "h",
      durationMs: 100,
      outcome: "error",
      errorCategory: "ProviderTimeout",
      failureKind: "timeout",
      phase: "send",
      trace: trace(ROOT_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
    const r = mapDiagnosticEventToWeaveSpan(event, cfg);
    if (r.kind !== "finalize") throw new Error("expected finalize");
    // Standard error.type stays as the OTel-stable form.
    expect(r.attrs["error.type"]).toBe("ProviderTimeout");
    // No gen_ai.outcome, gen_ai.failure.kind, gen_ai.harness.phase — those
    // would invent attributes outside the OTel registry.
    expect(r.attrs["weave.outcome"]).toBe("error");
    expect(r.attrs["gen_ai.outcome"]).toBeUndefined();
    expect(r.attrs["gen_ai.failure.kind"]).toBeUndefined();
    expect(r.attrs["gen_ai.harness.phase"]).toBeUndefined();
  });
});

describe("stripWrapperPrefix", () => {
  it("strips a Conversation info + Sender + timestamp wrapper, leaving the user text", () => {
    const wrapped = [
      "Conversation info (untrusted metadata):",
      "```json",
      "{",
      "  \"chat_id\": \"telegram:8787479535\",",
      "  \"message_id\": \"42\",",
      "  \"sender\": \"Rick Gao\"",
      "}",
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      "{",
      "  \"label\": \"Rick Gao\",",
      "  \"id\": \"8787479535\"",
      "}",
      "```",
      "[Sun 2026-05-03 22:11 PDT] what's a private officiant",
    ].join("\n");
    const stripped = stripWrapperPrefix(wrapped);
    expect(stripped).toBe("what's a private officiant");
  });

  it("strips a Sender-only wrapper (older format, no Conversation info block)", () => {
    const wrapped = [
      "Sender (untrusted metadata):",
      "```json",
      "{ \"label\": \"Rick Gao\", \"id\": \"123\" }",
      "```",
      "[Thu 2026-04-30 16:50 PDT] hello",
    ].join("\n");
    expect(stripWrapperPrefix(wrapped)).toBe("hello");
  });

  it("returns the input unchanged when no wrapper is present", () => {
    expect(stripWrapperPrefix("hello world")).toBe("hello world");
    expect(stripWrapperPrefix("")).toBe("");
  });

  it("handles legacy raw-JSON Sender block with brackets timestamp", () => {
    const wrapped = [
      "Sender (untrusted metadata):",
      "{ \"label\": \"Test\" }",
      "[Mon 2026-01-15 09:00 EST] real message",
    ].join("\n");
    expect(stripWrapperPrefix(wrapped)).toBe("real message");
  });
});

describe("input.prompt wrapper strip is gated by cfg.stripSenderWrapper", () => {
  // Same wrapper shape as the live OpenClaw runtime emits to user prompts.
  // Used as `llm.input.prompt` so the in-flight chat-view turn arrives at
  // `buildInputMessagesWithFlag` with the wrapper intact. The downstream
  // gate then either keeps it (default) or strips it.
  const wrappedPrompt = [
    "Conversation info (untrusted metadata):",
    "```json",
    "{ \"chat_id\": \"telegram:1\", \"sender\": \"Rick Gao\" }",
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    "{ \"label\": \"Rick Gao\", \"id\": \"1\" }",
    "```",
    "[Sun 2026-05-03 22:11 PDT] how much is a priest cost",
  ].join("\n");

  function buildEvent() {
    return {
      type: "model.call.completed",
      ts: 2000,
      seq: 5,
      runId: "r-1",
      callId: "c-1",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      durationMs: 200,
      trace: trace(CHILD_SPAN_ID),
    } as unknown as DiagnosticEventPayload;
  }

  function buildHookStateWithWrappedPrompt() {
    const hookState = createWeaveHookState();
    hookState.currentCallByRun.set("r-1", "c-1");
    hookState.llmInputs.set("c-1", {
      systemPrompt: "sys",
      prompt: wrappedPrompt,
      historyMessages: [],
    });
    return hookState;
  }

  function readLastUserContent(attrs: Record<string, string | number | boolean>): string {
    const messages = JSON.parse(String(attrs["weave.input.messages"]));
    expect(Array.isArray(messages)).toBe(true);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    return last.content as string;
  }

  it("default (stripSenderWrapper=false): wrapper SURVIVES in weave.input.messages — OTel-faithful", () => {
    // Default behavior matches OTel GenAI semconv: `gen_ai.input.messages` is
    // the messages used in the operation (i.e. what the LLM saw, wrappers and
    // all). Phoenix, Helicone, Langfuse, LangSmith all do the same.
    const cfg: ResolvedWeavePluginConfig = {
      ...baseCfg,
      stripSenderWrapper: false,
      captureContent: {
        enabled: true,
        inputMessages: true,
        outputMessages: false,
        toolArguments: false,
        toolResults: false,
        systemInstructions: false,
      },
    };
    const r = mapDiagnosticEventToWeaveSpan(buildEvent(), cfg, {
      hookState: buildHookStateWithWrappedPrompt(),
    });
    if (r.kind !== "finalize") throw new Error("expected finalize");
    const content = readLastUserContent(r.attrs);
    // Wrapper present at the start; user text at the tail.
    expect(content).toMatch(/^Conversation info \(untrusted metadata\):/);
    expect(content).toContain("how much is a priest cost");
  });

  it("opt-in (stripSenderWrapper=true): wrapper is STRIPPED from weave.input.messages — chat-view friendly", () => {
    // Operators wanting a clean Weave Agents-tab chat view enable this. They
    // accept the trade-off: prompt-injection inside the wrapper, scaffolding
    // bugs, or wrapper-format drift become invisible in the trace.
    const cfg: ResolvedWeavePluginConfig = {
      ...baseCfg,
      stripSenderWrapper: true,
      captureContent: {
        enabled: true,
        inputMessages: true,
        outputMessages: false,
        toolArguments: false,
        toolResults: false,
        systemInstructions: false,
      },
    };
    const r = mapDiagnosticEventToWeaveSpan(buildEvent(), cfg, {
      hookState: buildHookStateWithWrappedPrompt(),
    });
    if (r.kind !== "finalize") throw new Error("expected finalize");
    const content = readLastUserContent(r.attrs);
    // Wrapper gone, only the user's actual text remains.
    expect(content).toBe("how much is a priest cost");
  });
});
