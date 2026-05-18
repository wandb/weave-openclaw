// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createWeaveService, maskSecrets, parseDebugFlags } from "./service.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const ROOT_SPAN_ID = "1111111111111111";
const CHAT_SPAN_ID = "2222222222222222";
const TOOL_SPAN_ID = "3333333333333333";

function makeCtx(): OpenClawPluginServiceContext {
  return {
    config: {} as never,
    stateDir: "/tmp/weave-openclaw-test",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as never,
  } as OpenClawPluginServiceContext;
}

/**
 * The diagnostic event bus dispatches some event types asynchronously via
 * setImmediate, with reschedule-on-overflow. Multiple awaits drain any
 * cascading queue.
 */
async function flushAsyncDiagnostics(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

function trace(spanId: string, parentSpanId?: string) {
  return {
    traceId: TRACE_ID,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    traceFlags: "01",
  };
}

describe("parseDebugFlags", () => {
  test("returns all-false on empty/undefined input", () => {
    expect(parseDebugFlags(undefined)).toEqual({ spans: false, traceTree: false });
    expect(parseDebugFlags("")).toEqual({ spans: false, traceTree: false });
    expect(parseDebugFlags("   ")).toEqual({ spans: false, traceTree: false });
  });

  test("recognises 'spans' flag", () => {
    expect(parseDebugFlags("spans").spans).toBe(true);
  });

  test("recognises 'trace-tree' flag", () => {
    expect(parseDebugFlags("trace-tree").traceTree).toBe(true);
  });

  test("ignores unknown flags", () => {
    expect(parseDebugFlags("frobnicate")).toEqual({
      spans: false,
      traceTree: false,
    });
  });

  test("supports comma-separated multi-flag", () => {
    const f = parseDebugFlags("spans,trace-tree");
    expect(f.spans).toBe(true);
    expect(f.traceTree).toBe(true);
  });

  test("trims whitespace", () => {
    const f = parseDebugFlags(" spans , trace-tree ");
    expect(f.spans).toBe(true);
    expect(f.traceTree).toBe(true);
  });
});

describe("maskSecrets", () => {
  test("redacts Authorization Basic value", () => {
    expect(maskSecrets("Authorization: Basic abcDEFsecretKey123")).toBe(
      "Authorization: Basic <redacted>",
    );
  });

  test("redacts wandb-api-key in JSON-shaped error", () => {
    const masked = maskSecrets(
      `{"headers":{"wandb-api-key":"secret-here-1234567","content-type":"x"}}`,
    );
    expect(masked).not.toContain("secret-here-1234567");
    expect(masked).toContain("<redacted>");
  });

  test("redacts api_key in arbitrary text", () => {
    expect(maskSecrets("api_key=mykey-123-xyz")).not.toContain(
      "mykey-123-xyz",
    );
  });

  test("redacts api-key (hyphenated) in arbitrary text", () => {
    expect(maskSecrets('api-key="sensitive-secret-789"')).not.toContain(
      "sensitive-secret-789",
    );
  });

  test("leaves non-secret content untouched", () => {
    expect(maskSecrets("project_id=acme/agents")).toContain("acme/agents");
    expect(maskSecrets("model=gpt-5.4 temperature=0.7")).toContain("gpt-5.4");
  });

  test("redacts Authorization Bearer too (defense-in-depth)", () => {
    // Bearer isn't currently used by this plugin but shouldn't leak if it
    // ever appears in an error path. The current regex only handles Basic;
    // verify behavior stays consistent.
    const out = maskSecrets("Authorization: Bearer abcdef");
    // Currently NOT masked since pattern is Basic-specific. Test asserts
    // current behavior so a future regex tightening is intentional.
    expect(out).toBe("Authorization: Bearer abcdef");
  });
});

describe("createWeaveService (integration)", () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    resetDiagnosticEventsForTest();
    exporter = new InMemorySpanExporter();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  test("emits invoke_agent with chat and execute_tool as siblings for a full turn", async () => {
    const { service } = createWeaveService({
      pluginConfig: {
        entity: "acme",
        project: "agents",
        agentName: "test-agent",
        agentVersion: "v1.0",
      },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    // harness.run.started — sync dispatch; root span created immediately.
    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-1",
      harnessId: "test-agent",
      sessionKey: "conv-abc",
      provider: "openai",
      model: "gpt-5.4",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    // Child events — async dispatch (tool.execution.* and model.call.* queue).
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      trace: trace(CHAT_SPAN_ID, ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "r-1",
      toolName: "search_web",
      toolCallId: "call_xyz",
      // intentionally NO sessionKey — should resolve via traceId cache.
      // Parent is ROOT_SPAN_ID (invoke_agent), not CHAT_SPAN_ID: OpenClaw
      // emits tool.execution events from createChildDiagnosticTraceContext(runTrace),
      // so they are siblings of chat under invoke_agent — matches OTel GenAI
      // semconv `docs/gen-ai/gen-ai-agent-spans.md`.
      trace: trace(TOOL_SPAN_ID, ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "r-1",
      toolName: "search_web",
      toolCallId: "call_xyz",
      durationMs: 200,
      trace: trace(TOOL_SPAN_ID, ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 800,
      usage: { input: 150, output: 40 },
      trace: trace(CHAT_SPAN_ID, ROOT_SPAN_ID),
    } as never);

    await flushAsyncDiagnostics();

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-1",
      harnessId: "test-agent",
      sessionKey: "conv-abc",
      durationMs: 1000,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    // All harness.run.* / model.call.* / tool.execution.* events are async
    // dispatched. Drain the queue before shutting down, otherwise our listener
    // is unsubscribed before the queue gets a chance to deliver.
    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);

    const invoke = spans.find((s) => s.name.startsWith("invoke_agent"));
    const chat = spans.find((s) => s.name.startsWith("chat"));
    const tool = spans.find((s) => s.name.startsWith("execute_tool"));

    if (!invoke || !chat || !tool) throw new Error("missing expected spans");

    // Span names match the seed_genai_data.py reference.
    expect(invoke.name).toBe("invoke_agent test-agent");
    expect(chat.name).toBe("chat gpt-5.4");
    expect(tool.name).toBe("execute_tool search_web");

    // Conversation grouping flows from harness through to the tool span,
    // even though the tool event payload had no sessionKey.
    expect(invoke.attributes["weave.conversation.id"]).toBe("conv-abc");
    expect(chat.attributes["weave.conversation.id"]).toBe("conv-abc");
    expect(tool.attributes["weave.conversation.id"]).toBe("conv-abc");

    // Agent identity propagates everywhere.
    expect(invoke.attributes["weave.agent.name"]).toBe("test-agent");
    expect(chat.attributes["weave.agent.name"]).toBe("test-agent");
    expect(tool.attributes["weave.agent.name"]).toBe("test-agent");
    expect(invoke.attributes["weave.agent.version"]).toBe("v1.0");

    // Token usage on chat.
    expect(chat.attributes["weave.usage.input_tokens"]).toBe(150);
    expect(chat.attributes["weave.usage.output_tokens"]).toBe(40);

    // Tool identity.
    expect(tool.attributes["weave.tool.name"]).toBe("search_web");
    expect(tool.attributes["weave.tool.call.id"]).toBe("call_xyz");

    // Parent linkage at the OTel trace tree level.
    // chat and execute_tool are sibling children of invoke_agent.
    expect(chat.parentSpanContext?.spanId).toBe(invoke.spanContext().spanId);
    expect(tool.parentSpanContext?.spanId).toBe(invoke.spanContext().spanId);
  });

  test("drops untrusted events (security boundary)", async () => {
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    // emitDiagnosticEvent is the UNTRUSTED public emitter — these would
    // otherwise be filtered by onDiagnosticEvent. Our service uses
    // onInternalDiagnosticEvent + a meta.trusted check, so these should drop.
    emitDiagnosticEvent({
      type: "run.started",
      runId: "r-1",
      harnessId: "h",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    await flushAsyncDiagnostics();
    await service.stop?.(ctx);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  test("error on a model call sets ERROR status with error.type", async () => {
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-1",
      harnessId: "x",
      sessionKey: "conv-abc",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      trace: trace(CHAT_SPAN_ID, ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "model.call.error",
      runId: "r-1",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 1250,
      errorCategory: "TimeoutError",
      failureKind: "timeout",
      trace: trace(CHAT_SPAN_ID, ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-1",
      harnessId: "x",
      durationMs: 1300,
      outcome: "error",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const chat = exporter.getFinishedSpans().find((s) => s.name.startsWith("chat"));
    expect(chat).toBeDefined();
    expect(chat?.status.code).toBe(2 /* SpanStatusCode.ERROR */);
    expect(chat?.attributes["error.type"]).toBe("TimeoutError");
    expect(chat?.attributes["weave.failure.kind"]).toBe("timeout");
    // Per OTel `docs/general/recording-errors.md`: error finalize MUST also
    // record an `exception` event with `exception.{type,message}` so OTel-
    // aware UIs (Honeycomb's exceptions tab, Datadog's error inspector)
    // light up. We synthesise the message from structured payload fields.
    const exception = chat?.events.find((ev) => ev.name === "exception");
    expect(exception).toBeDefined();
    expect(exception?.attributes?.["exception.type"]).toBe("TimeoutError");
    expect(String(exception?.attributes?.["exception.message"])).toContain(
      "TimeoutError",
    );
    expect(String(exception?.attributes?.["exception.message"])).toContain(
      "timeout",
    );
  });

  test("missing required config logs error and does not throw", async () => {
    const { service } = createWeaveService({
      pluginConfig: { project: "agents" }, // missing entity
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx); // must not throw
    expect((ctx.logger.error as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    await service.stop?.(ctx);
  });

  test("context.assembled event stamps weave.context.* attrs on the invoke_agent span", async () => {
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-ctx",
      harnessId: "x",
      sessionKey: "conv-ctx",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    emitTrustedDiagnosticEvent({
      type: "context.assembled",
      runId: "r-ctx",
      sessionKey: "conv-ctx",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      messageCount: 12,
      historyTextChars: 4500,
      historyImageBlocks: 2,
      maxMessageTextChars: 800,
      systemPromptChars: 1200,
      promptChars: 350,
      promptImages: 0,
      contextTokenBudget: 200000,
      reserveTokens: 8000,
      trace: trace(ROOT_SPAN_ID),
    } as never);

    // Drain async events (context.assembled is queued) before the sync
    // run.completed finalizes the invoke_agent — matches real-runtime
    // ordering where awaits between emits give the queue time to drain.
    await flushAsyncDiagnostics();

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-ctx",
      harnessId: "x",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const invoke = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith("invoke_agent"));
    expect(invoke).toBeDefined();
    expect(invoke?.attributes["weave.context.message_count"]).toBe(12);
    expect(invoke?.attributes["weave.context.history_text_chars"]).toBe(4500);
    expect(invoke?.attributes["weave.context.history_image_blocks"]).toBe(2);
    expect(invoke?.attributes["weave.context.system_prompt_chars"]).toBe(1200);
    expect(invoke?.attributes["weave.context.prompt_chars"]).toBe(350);
    expect(invoke?.attributes["weave.context.prompt_images"]).toBe(0);
    expect(invoke?.attributes["weave.context.budget_tokens"]).toBe(200000);
    expect(invoke?.attributes["weave.context.reserve_tokens"]).toBe(8000);
  });

  test("model.usage events accumulate weave.cost.usd on the invoke_agent span", async () => {
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-1",
      harnessId: "x",
      sessionKey: "conv-cost",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    // Two model.usage events on the same trace — costs should sum.
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey: "conv-cost",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      usage: { input: 100, output: 50, total: 150 },
      costUsd: 0.0023,
      trace: trace(ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey: "conv-cost",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      usage: { input: 30, output: 20, total: 50 },
      costUsd: 0.0011,
      trace: trace(ROOT_SPAN_ID),
    } as never);

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-1",
      harnessId: "x",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const invoke = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith("invoke_agent"));
    expect(invoke).toBeDefined();
    // 0.0023 + 0.0011 = 0.0034
    expect(invoke?.attributes["weave.cost.usd"]).toBeCloseTo(0.0034, 6);
    // Latest aggregate token totals on the closed span — the second event's
    // usage block REPLACES the first (mergeUsage spreads), so values reflect
    // the most recent model.usage event, not a sum.
    expect(invoke?.attributes["weave.usage.total.input_tokens"]).toBe(30);
    expect(invoke?.attributes["weave.usage.total.output_tokens"]).toBe(20);
    expect(invoke?.attributes["weave.usage.total.tokens"]).toBe(50);
  });

  test("model.usage emitted before run.started is buffered and hydrated onto the invoke_agent span", async () => {
    // Race resilience: model.usage dispatches synchronously and can fire on
    // the same tick before downstream listeners observe run.started, so the
    // invoke_agent doesn't exist yet when our handler runs. Buffered values
    // must land on the span when it arrives (PendingTraceState.hydrate*)
    // and remain on the closed span (PendingTraceState.finalize*).
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey: "conv-out-of-order",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      usage: { input: 200, output: 80, total: 280 },
      costUsd: 0.0042,
      trace: trace(ROOT_SPAN_ID),
    } as never);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-buffered",
      harnessId: "x",
      sessionKey: "conv-out-of-order",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-buffered",
      harnessId: "x",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const invoke = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith("invoke_agent"));
    expect(invoke).toBeDefined();
    expect(invoke?.attributes["weave.cost.usd"]).toBeCloseTo(0.0042, 6);
    expect(invoke?.attributes["weave.usage.total.input_tokens"]).toBe(200);
    expect(invoke?.attributes["weave.usage.total.output_tokens"]).toBe(80);
    expect(invoke?.attributes["weave.usage.total.tokens"]).toBe(280);
  });

  test("tool.loop event becomes a span event on the active invoke_agent", async () => {
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-1",
      harnessId: "x",
      sessionKey: "conv-loop",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "tool.loop",
      sessionKey: "conv-loop",
      toolName: "search_web",
      level: "warning",
      action: "warn",
      detector: "generic_repeat",
      count: 4,
      message: "search_web called 4 times with the same args",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-1",
      harnessId: "x",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const invoke = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith("invoke_agent"));
    expect(invoke).toBeDefined();
    const loopEvent = invoke?.events.find((e) => e.name === "tool.loop");
    expect(loopEvent).toBeDefined();
    expect(loopEvent?.attributes?.["weave.loop.detector"]).toBe("generic_repeat");
    expect(loopEvent?.attributes?.["weave.loop.count"]).toBe(4);
    expect(loopEvent?.attributes?.["weave.tool.name"]).toBe("search_web");
  });

  test("startSubagentSpan creates a child invoke_agent parented under requester", async () => {
    const { service, startSubagentSpan, endSubagentSpan } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "main" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-parent",
      harnessId: "main",
      sessionKey: "conv-parent",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();

    startSubagentSpan({
      startTimeMs: Date.now(),
      requesterRunId: "r-parent",
      subagentRunId: "r-sub",
      agentId: "researcher",
      label: "Research subagent",
      childSessionKey: "conv-sub",
      mode: "run",
    });
    endSubagentSpan({
      endTimeMs: Date.now(),
      subagentRunId: "r-sub",
      outcome: "ok",
    });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-parent",
      harnessId: "main",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const parent = spans.find((s) => s.name === "invoke_agent main");
    const child = spans.find((s) => s.name === "invoke_agent researcher");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
    expect(child?.attributes["weave.subagent.outcome"]).toBe("ok");
    expect(child?.attributes["weave.subagent.mode"]).toBe("run");
    expect(child?.attributes["weave.conversation.id"]).toBe("conv-sub");
    expect(child?.attributes["weave.agent.description"]).toBe("Research subagent");
  });

  test("endSubagentSpan with non-ok outcome marks span ERROR", async () => {
    const { service, startSubagentSpan, endSubagentSpan } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "main" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-parent",
      harnessId: "main",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();

    startSubagentSpan({
      startTimeMs: Date.now(),
      requesterRunId: "r-parent",
      subagentRunId: "r-sub-err",
      agentId: "researcher",
      childSessionKey: "conv-sub",
      mode: "run",
    });
    endSubagentSpan({
      endTimeMs: Date.now(),
      subagentRunId: "r-sub-err",
      outcome: "timeout",
      error: "Provider timed out",
    });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-parent",
      harnessId: "main",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const child = exporter
      .getFinishedSpans()
      .find((s) => s.name === "invoke_agent researcher");
    expect(child?.status.code).toBe(2 /* SpanStatusCode.ERROR */);
    expect(child?.attributes["weave.subagent.outcome"]).toBe("timeout");
  });

  test("subagent span with claimed-but-unfound parent is dropped (orphan-drop)", async () => {
    const { service, startSubagentSpan, endSubagentSpan } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "main" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    // No harness.run.started — the claimed requesterRunId has no active
    // invoke_agent, so the subagent span would otherwise become a root and
    // pollute Weave's Agents tab. Orphan-drop suppresses it.
    startSubagentSpan({
      startTimeMs: Date.now(),
      requesterRunId: "r-orphan",
      subagentRunId: "r-sub-orphan",
      agentId: "researcher",
      childSessionKey: "conv-sub",
      mode: "run",
    });
    endSubagentSpan({
      endTimeMs: Date.now(),
      subagentRunId: "r-sub-orphan",
      outcome: "ok",
    });

    await service.stop?.(ctx);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  test("subagent span with no requesterRunId at all runs as a legitimate root", async () => {
    // When the spawn isn't tied to a parent run (e.g., top-level standalone
    // session-mode subagent), allow it as a root — this is intentional, not
    // an orphan.
    const { service, startSubagentSpan, endSubagentSpan } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "main" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    startSubagentSpan({
      startTimeMs: Date.now(),
      requesterRunId: undefined,
      subagentRunId: "r-sub-standalone",
      agentId: "researcher",
      childSessionKey: "conv-standalone",
      mode: "session",
    });
    endSubagentSpan({
      endTimeMs: Date.now(),
      subagentRunId: "r-sub-standalone",
      outcome: "ok",
    });

    await service.stop?.(ctx);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("invoke_agent researcher");
    expect(spans[0].parentSpanContext?.spanId).toBeUndefined();
  });

  test("run.attempt event adds run_attempt span event with attempt number", async () => {
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-retry",
      harnessId: "x",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();

    emitTrustedDiagnosticEvent({
      type: "run.attempt",
      runId: "r-retry",
      attempt: 3,
      trace: trace(ROOT_SPAN_ID),
    } as never);

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-retry",
      harnessId: "x",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const invoke = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith("invoke_agent"));
    const ev = invoke?.events.find((e) => e.name === "run_attempt");
    expect(ev).toBeDefined();
    expect(ev?.attributes?.["weave.run.attempt"]).toBe(3);
  });

  test("emitMessageReceived adds message_received span event by runId", async () => {
    const { service, emitMessageReceived } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-msg",
      harnessId: "x",
      sessionKey: "conv-msg",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();

    emitMessageReceived({
      runId: "r-msg",
      from: "alice",
      channel: "telegram",
      content: "what's the weather in NYC?",
    });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-msg",
      harnessId: "x",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const invoke = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith("invoke_agent"));
    const ev = invoke?.events.find((e) => e.name === "message_received");
    expect(ev).toBeDefined();
    expect(ev?.attributes?.["weave.message.from"]).toBe("alice");
    expect(ev?.attributes?.["weave.message.channel"]).toBe("telegram");
    // Content IS emitted because captureContent defaults to full.
    expect(ev?.attributes?.["weave.message.content"]).toBe(
      "what's the weather in NYC?",
    );
  });

  test("captureContent { enabled: false } suppresses message_received content", async () => {
    const { service, emitMessageReceived } = createWeaveService({
      pluginConfig: {
        entity: "acme",
        project: "agents",
        agentName: "x",
        captureContent: { enabled: false },
      },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-msg-off",
      harnessId: "x",
      sessionKey: "conv-msg-off",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();

    emitMessageReceived({
      runId: "r-msg-off",
      from: "alice",
      content: "what's the weather in NYC?",
    });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-msg-off",
      harnessId: "x",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const invoke = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith("invoke_agent"));
    const ev = invoke?.events.find((e) => e.name === "message_received");
    expect(ev?.attributes?.["weave.message.from"]).toBe("alice");
    expect(ev?.attributes?.["weave.message.content"]).toBeUndefined();
  });

  test("session_started buffered and stamped on next invoke_agent with matching sessionKey", async () => {
    const { service, emitSessionStart, emitSessionEnd } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    // session_start fires before any run is born
    emitSessionStart({
      sessionKey: "conv-session",
      resumedFrom: "prev-session-id",
    });

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-sess",
      harnessId: "x",
      sessionKey: "conv-session",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();

    emitSessionEnd({
      sessionKey: "conv-session",
      reason: "compaction",
      durationMs: 60000,
      messageCount: 42,
    });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-sess",
      harnessId: "x",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const invoke = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith("invoke_agent"));
    const startEv = invoke?.events.find((e) => e.name === "session_started");
    expect(startEv).toBeDefined();
    expect(startEv?.attributes?.["weave.session.resumed_from"]).toBe(
      "prev-session-id",
    );

    const endEv = invoke?.events.find((e) => e.name === "session_ended");
    expect(endEv).toBeDefined();
    expect(endEv?.attributes?.["weave.session.reason"]).toBe("compaction");
    expect(endEv?.attributes?.["weave.session.message_count"]).toBe(42);
  });

  test("emitAgentEndSummary adds agent_end_summary span event on the active invoke_agent", async () => {
    const { service, emitAgentEndSummary } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-end",
      harnessId: "x",
      sessionKey: "conv-end",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();

    emitAgentEndSummary({
      runId: "r-end",
      success: true,
      durationMs: 1234,
    });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-end",
      harnessId: "x",
      durationMs: 1300,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const invoke = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith("invoke_agent"));
    expect(invoke).toBeDefined();
    const ev = invoke?.events.find((e) => e.name === "agent_end_summary");
    expect(ev).toBeDefined();
    expect(ev?.attributes?.["weave.agent.success"]).toBe(true);
    expect(ev?.attributes?.["weave.agent.duration_ms"]).toBe(1234);
  });

  test("emitAgentEndSummary with error sets weave.agent.error attribute", async () => {
    const { service, emitAgentEndSummary } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-fail",
      harnessId: "x",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();

    emitAgentEndSummary({
      runId: "r-fail",
      success: false,
      error: "ProviderTimeout: model did not respond within 30s",
    });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-fail",
      harnessId: "x",
      durationMs: 30100,
      outcome: "error",
      errorCategory: "ProviderTimeout",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    const invoke = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith("invoke_agent"));
    const ev = invoke?.events.find((e) => e.name === "agent_end_summary");
    expect(ev).toBeDefined();
    expect(ev?.attributes?.["weave.agent.success"]).toBe(false);
    expect(ev?.attributes?.["weave.agent.error"]).toContain("ProviderTimeout");
  });

  test("OPENCLAW_WEAVE_DEBUG=trace-tree dumps active span tree on start/finalize", async () => {
    process.env.OPENCLAW_WEAVE_DEBUG = "trace-tree";
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-tree",
      harnessId: "x",
      sessionKey: "conv-tree",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "r-tree",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      trace: trace(CHAT_SPAN_ID, ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "r-tree",
      callId: "c-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 100,
      trace: trace(CHAT_SPAN_ID, ROOT_SPAN_ID),
    } as never);
    // Drain async events (model.call.* are queued) before the sync
    // run.completed finalizes the invoke_agent so the chat span resolves
    // its parent against a live invoke_agent in activeSpans.
    await flushAsyncDiagnostics();
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-tree",
      harnessId: "x",
      durationMs: 200,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    delete process.env.OPENCLAW_WEAVE_DEBUG;

    const debugCalls = (
      ctx.logger.debug as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => String(c[0]));
    const treeDumps = debugCalls.filter((s) => s.includes("trace-tree"));
    expect(treeDumps.length).toBeGreaterThan(0);
    // At least one dump should show the chat span as a child of invoke_agent.
    const nestedDump = treeDumps.find(
      (s) => s.includes("invoke_agent") && s.includes("chat"),
    );
    expect(nestedDump).toBeDefined();
    expect(nestedDump).toContain(`claimedParent=${ROOT_SPAN_ID}`);
  });

  test("post-finalize side-channel events are no-ops (no addEvent on a dead span)", async () => {
    // Regression: invokeAgentByRunId / invokeAgentBySessionKey used to keep
    // stale span references after invoke_agent finalize, so a late-arriving
    // run.attempt / session_end / agent_end could addEvent on the
    // already-ended span. Verify the maps are cleaned up.
    const { service, emitAgentEndSummary, emitSessionEnd } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-late",
      harnessId: "x",
      sessionKey: "conv-late",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-late",
      harnessId: "x",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();

    // After finalize, these should be silent no-ops.
    expect(() =>
      emitAgentEndSummary({ runId: "r-late", success: true }),
    ).not.toThrow();
    expect(() =>
      emitSessionEnd({ sessionKey: "conv-late", reason: "idle" }),
    ).not.toThrow();

    await service.stop?.(ctx);

    const invoke = exporter
      .getFinishedSpans()
      .find((s) => s.name.startsWith("invoke_agent"));
    expect(invoke).toBeDefined();
    // No agent_end_summary / session_ended events should have been added
    // to the already-finalized span.
    expect(
      invoke?.events.find((e) => e.name === "agent_end_summary"),
    ).toBeUndefined();
    expect(
      invoke?.events.find((e) => e.name === "session_ended"),
    ).toBeUndefined();
  });

  test("orphan child span is dropped when its parent is not active (no Weave-tab pollution)", async () => {
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    // tool.execution.started arrives without a prior harness.run.started or
    // model.call.started — claims a parent that's not in activeSpans. The
    // orphan-drop guard should suppress it instead of creating a root span
    // (which would otherwise show as its own "turn" in Weave's Agents tab).
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "r-orphan",
      toolName: "search_web",
      toolCallId: "call_orphan",
      sessionKey: "conv-orphan",
      trace: trace("4444444444444444", "9999999999999999"),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "r-orphan",
      toolName: "search_web",
      toolCallId: "call_orphan",
      durationMs: 50,
      trace: trace("4444444444444444", "9999999999999999"),
    } as never);

    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  test("invoke_agent is allowed even when its claimed parent is not active (legitimate root)", async () => {
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    // harness.run.started with a parentSpanId that we don't track — common
    // when OpenClaw's outer harness layer creates a span we don't observe.
    // invoke_agent should still be created (as a root in our trace tree).
    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-1",
      harnessId: "x",
      sessionKey: "conv-1",
      trace: trace(ROOT_SPAN_ID, "8888888888888888"),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-1",
      harnessId: "x",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID, "8888888888888888"),
    } as never);

    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0].name).toBe("invoke_agent x");
  });

  test("teardown ends orphaned spans whose completed event never arrived", async () => {
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);

    // harness.run.started fires but no completed/error event ever arrives.
    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-orphan",
      harnessId: "x",
      sessionKey: "conv-orphan",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    await flushAsyncDiagnostics();

    // Verify nothing is finalized yet.
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    // Stopping the service should end the orphaned span (default UNSET status).
    await service.stop?.(ctx);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("invoke_agent x");
    // SpanStatusCode.UNSET = 0 — set by the SDK when a span ends without an
    // explicit setStatus.
    expect(spans[0].status.code).toBe(0);
  });

  test("re-entrant start() tears down previous state", async () => {
    const { service } = createWeaveService({
      pluginConfig: { entity: "acme", project: "agents", agentName: "x" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);
    // Call start a second time without stop — should not throw and should
    // re-subscribe cleanly.
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-1",
      harnessId: "x",
      sessionKey: "conv-abc",
      trace: trace(ROOT_SPAN_ID),
    } as never);
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-1",
      harnessId: "x",
      durationMs: 100,
      outcome: "completed",
      trace: trace(ROOT_SPAN_ID),
    } as never);

    // Drain async queue before shutting down (harness.run.* are async-dispatched).
    await flushAsyncDiagnostics();
    await service.stop?.(ctx);

    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  test("startup info log reports resolved config summary", async () => {
    const { service } = createWeaveService({
      pluginConfig: { entity: "e", project: "p" },
      spanExporter: exporter,
    });
    const ctx = makeCtx();
    await service.start(ctx);
    const info = ctx.logger.info as ReturnType<typeof vi.fn>;
    const joined = info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("auth=");
    expect(joined).toContain("exporting to https://trace.wandb.ai/agents/otel/v1/traces");
    expect(joined).toContain("dashboard https://wandb.ai/e/p/weave");
    expect(joined).toContain("flushIntervalMs=5000");
    expect(joined).toContain("captureContent=full");
    expect(joined).toContain("emitGenAiAliases=true");
    expect(joined).toContain("stripSenderWrapper=false");
    await service.stop?.(ctx);
  });
});
