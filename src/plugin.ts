// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { flushOTel, init as weaveInit, runIsolated, startSession, startTurn } from "weave";
import type { Message, Usage } from "weave";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import type { WeaveHookState } from "./hook-state.js";
import {
  beginModelCall,
  bufferPendingLlmInputForRun,
  resolveCurrentCallId,
  captureLlmInput,
  captureLlmOutput,
  captureToolStart,
  captureToolEnd,
  lookupToolCall,
} from "./hook-state.js";
import { resolveConfig, type RawConfig, type ResolvedConfig } from "./config.js";
import { createRegistries, MAX_ENTRIES, type Registries } from "./registries.js";
import { setBoundedMap } from "./bounded-map.js";
import { formatStatus, type StatusSnapshot } from "./status.js";
import { PACKAGE_VERSION } from "./version.js";

export type CreateWeavePluginParams = {
  pluginConfig?: unknown;
  hookState: WeaveHookState;
};

export type WeavePlugin = {
  service: OpenClawPluginService;
  registries: Registries;
  getStatus: () => StatusSnapshot;
  /** Populated by event-wiring tasks (8-12); empty here. */
  handlers: {
    hook: Record<string, (event: any, ctx?: any) => void>;
    diagnostic?: (event: any, meta: { trusted: boolean }) => void;
  };
};

export function createWeavePlugin(params: CreateWeavePluginParams): WeavePlugin {
  const registries = createRegistries();
  let resolved: ResolvedConfig | undefined;
  let lifecycle: StatusSnapshot["lifecycle"] = "not-started";
  let lifecycleDetail: string | undefined;
  let startedAt: number | undefined;

  const service: OpenClawPluginService = {
    id: "weave",
    async start(ctx) {
      // If start() is being called without a prior stop(), tear down
      // the prior run's state first so registries don't accumulate.
      if (lifecycle === "running") {
        registries.sessions.clear();
        registries.turns.clear();
        registries.calls.clear();
        registries.tools.clear();
        registries.subagents.clear();
      }
      resolved = undefined;
      startedAt = undefined;
      lifecycle = "not-started";
      lifecycleDetail = undefined;
      let cfg: ResolvedConfig;
      try {
        cfg = await resolveConfig((params.pluginConfig ?? {}) as RawConfig);
      } catch (err) {
        lifecycle = "config-error";
        lifecycleDetail = err instanceof Error ? err.message : String(err);
        ctx.logger.error(`weave: ${lifecycleDetail}`);
        return;
      }
      if (!cfg.enabled) {
        lifecycle = "disabled";
        lifecycleDetail = "config.enabled=false";
        ctx.logger.warn(
          `weave: configured but disabled (config.enabled=false)`,
        );
        return;
      }
      if (cfg.apiKey) {
        process.env.WANDB_API_KEY = cfg.apiKey;
      } else if (!process.env.WANDB_API_KEY) {
        lifecycle = "config-error";
        lifecycleDetail = "no W&B API key found";
        ctx.logger.error(
          `weave: ${lifecycleDetail} (set WANDB_API_KEY env or weave.apiKey config)`,
        );
        return;
      }
      try {
        await weaveInit(cfg.projectId, {
          genai: { batchOptions: { scheduledDelayMillis: cfg.flushIntervalMs } },
        });
      } catch (err) {
        lifecycle = "config-error";
        lifecycleDetail = err instanceof Error ? err.message : String(err);
        ctx.logger.error(`weave: init failed: ${lifecycleDetail}`);
        return;
      }
      resolved = cfg;
      lifecycle = "running";
      startedAt = Date.now();
      ctx.logger.info(
        `weave: project=${cfg.projectId} service=${cfg.serviceName} agentVersion=${cfg.agentVersion} ` +
          `auth=${cfg.authSource ?? "WANDB_API_KEY env"} captureContent=${cfg.captureContent ? "on" : "off"}`,
      );
    },
    async stop(ctx) {
      lifecycle = "stopped";
      try {
        await flushOTel();
      } catch (err) {
        ctx?.logger?.warn?.(
          `weave: flushOTel failed during stop: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      registries.sessions.clear();
      registries.turns.clear();
      registries.calls.clear();
      registries.tools.clear();
      registries.subagents.clear();
    },
  };

  function getStatus(): StatusSnapshot {
    const snap: StatusSnapshot = {
      pluginVersion: PACKAGE_VERSION,
      lifecycle,
      lifecycleDetail,
      startedAt,
    };
    if (resolved) {
      const wandbBase = process.env.WANDB_BASE_URL?.trim();
      const uiUrl =
        !wandbBase || wandbBase === "https://api.wandb.ai"
          ? `https://wandb.ai/${resolved.projectId}/weave`
          : undefined;
      snap.config = {
        projectId: resolved.projectId,
        serviceName: resolved.serviceName,
        agentVersion: resolved.agentVersion,
        flushIntervalMs: resolved.flushIntervalMs,
        captureContent: resolved.captureContent,
        stripSenderWrapper: resolved.stripSenderWrapper,
        authSource: resolved.authSource ?? "WANDB_API_KEY env",
        uiUrl,
      };
      snap.counts = {
        turns: registries.turns.size,
        calls: registries.calls.size,
        tools: registries.tools.size,
        subagents: registries.subagents.size,
      };
    }
    return snap;
  }

  const handlers: WeavePlugin["handlers"] = {
    hook: {},
  };

  handlers.hook.session_start = (event) => {
    const key = event.sessionKey;
    if (!key || !resolved || registries.sessions.has(key)) return;
    const session = runIsolated(() =>
      startSession({
        sessionId: key,
        agentName: resolved!.agentName,
      }),
    );
    setBoundedMap(registries.sessions, key, session, MAX_ENTRIES);
  };

  handlers.hook.session_end = (event) => {
    const key = event.sessionKey;
    if (!key) return;
    registries.sessions.get(key)?.end();
    registries.sessions.delete(key);
  };

  handlers.hook.agent_end = (event) => {
    const turn = registries.turns.get(event.runId);
    if (!turn) return;
    if (typeof event.success === "boolean") {
      turn.setAttribute("weave.agent.success", event.success);
    }
    if (event.error) turn.setAttribute("weave.agent.error", String(event.error));
    if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) {
      turn.setAttribute("weave.agent.duration_ms", Math.trunc(event.durationMs));
    }
  };

  handlers.hook.before_tool_call = (event) => {
    if (!event.toolCallId) return;
    captureToolStart(params.hookState, event.toolCallId, {
      toolName: event.toolName,
      params: event.params,
      runId: event.runId,
    });
  };

  handlers.hook.after_tool_call = (event) => {
    if (!event.toolCallId) return;
    captureToolEnd(params.hookState, event.toolCallId, {
      result: event.result,
    });
  };

  handlers.hook.model_call_started = (event) => {
    if (event.runId && event.callId) {
      beginModelCall(params.hookState, event.runId, event.callId);
    }
  };

  handlers.hook.llm_input = (event) => {
    const capture = {
      systemPrompt: event.systemPrompt,
      prompt: event.prompt,
      historyMessages: event.historyMessages,
    };
    const callId = event.runId
      ? resolveCurrentCallId(params.hookState, event.runId)
      : undefined;
    if (callId) {
      captureLlmInput(params.hookState, callId, capture);
    } else if (event.runId) {
      bufferPendingLlmInputForRun(params.hookState, event.runId, capture);
    }
  };

  handlers.hook.llm_output = (event) => {
    const callId = event.runId
      ? resolveCurrentCallId(params.hookState, event.runId)
      : undefined;
    if (!callId) return;
    captureLlmOutput(params.hookState, callId, {
      assistantTexts: event.assistantTexts ?? [],
      lastAssistant: event.lastAssistant,
      usage: event.usage,
    });
    const h = registries.calls.get(callId);
    if (h) {
      h.hookDone = true;
      maybeCloseLlm(callId);
    }
  };

  handlers.diagnostic = (event, meta) => {
    if (!meta.trusted) return;
    if (event.type === "run.started") return onRunStarted(event);
    if (event.type === "run.completed") return onRunFinalize(event);
    if (event.type === "model.call.started") return onChatStart(event);
    if (event.type === "model.call.completed") return onChatFinalize(event, "ok", undefined);
    if (event.type === "model.call.error") return onChatFinalize(event, "error", event.errorCategory);
    if (event.type === "tool.execution.started") return onToolStart(event);
    if (event.type === "tool.execution.completed") return onToolFinalize(event, "ok", undefined);
    if (event.type === "tool.execution.error") return onToolFinalize(event, "error", event.errorCategory);
    if (event.type === "tool.execution.blocked") return onToolFinalize(event, "error", "blocked");
  };

  function onRunStarted(event: any): void {
    if (!resolved) return;
    if (registries.turns.has(event.runId)) return;
    const sessionKey: string | undefined = event.sessionKey;
    const existingSession = sessionKey ? registries.sessions.get(sessionKey) : undefined;
    const session =
      existingSession ??
      (sessionKey
        ? (() => {
            const s = runIsolated(() =>
              startSession({
                sessionId: sessionKey,
                agentName: resolved!.agentName,
              }),
            );
            setBoundedMap(registries.sessions, sessionKey, s, MAX_ENTRIES);
            return s;
          })()
        : undefined);
    const turn = runIsolated(() =>
      session
        ? session.startTurn({ agentName: resolved!.agentName, model: event.model })
        : startTurn({ agentName: resolved!.agentName, model: event.model }),
    );
    if (resolved.agentVersion) turn.setAttribute("weave.agent.version", resolved.agentVersion);
    if (resolved.agentDescription) turn.setAttribute("weave.agent.description", resolved.agentDescription);
    setBoundedMap(registries.turns, event.runId, turn, MAX_ENTRIES);
  }

  function onRunFinalize(event: any): void {
    const turn = registries.turns.get(event.runId);
    if (!turn) return;
    const outcome = typeof event.outcome === "string" ? event.outcome : undefined;
    if (outcome) turn.setAttribute("weave.outcome", outcome);
    if (outcome && outcome !== "completed") {
      turn.end({ error: new Error(outcome) });
    } else {
      turn.end();
    }
    registries.turns.delete(event.runId);
  }

  function onChatStart(event: any): void {
    if (!resolved) return;
    const runId: string | undefined = event.runId;
    const callId: string | undefined = event.callId;
    if (!runId || !callId) return;
    const turn = registries.turns.get(runId);
    if (!turn) return;
    const llm = runIsolated(() =>
      turn.startLLM({
        model: event.model ?? "unknown",
        providerName: event.provider,
      }),
    );
    setBoundedMap(
      registries.calls,
      callId,
      { llm, hookDone: false, diagDone: false, status: "ok" },
      MAX_ENTRIES,
    );
  }

  function onChatFinalize(event: any, status: "ok" | "error", errorType: string | undefined): void {
    const callId: string | undefined = event.callId;
    if (!callId) return;
    const h = registries.calls.get(callId);
    if (!h) return;
    h.diagDone = true;
    h.endTimeMs = event.ts;
    h.status = status;
    h.errorType = errorType;
    // Errors don't wait for llm_output (it never fires on error).
    if (status === "error") h.hookDone = true;
    maybeCloseLlm(callId);
  }

  function maybeCloseLlm(callId: string): void {
    const h = registries.calls.get(callId);
    if (!h || !h.hookDone || !h.diagDone) return;
    const cap = {
      input: params.hookState.llmInputs.get(callId),
      output: params.hookState.llmOutputs.get(callId),
    };
    const shaped = shapeMessages(cap, resolved?.captureContent ?? false);
    if (shaped.input.length || shaped.output.length || shaped.usage) {
      h.llm.record({
        inputMessages: shaped.input,
        outputMessages: shaped.output,
        usage: shaped.usage,
      });
    }
    h.llm.end(
      h.status === "error"
        ? { error: new Error(h.errorType ?? "model.call.error") }
        : undefined,
    );
    registries.calls.delete(callId);
    params.hookState.llmInputs.delete(callId);
    params.hookState.llmOutputs.delete(callId);
  }

  function onToolStart(event: any): void {
    if (!resolved) return;
    const runId: string | undefined = event.runId;
    const toolCallId: string | undefined = event.toolCallId;
    if (!runId || !toolCallId) return;
    const turn = registries.turns.get(runId);
    if (!turn) return;
    const captured = lookupToolCall(params.hookState, toolCallId).args;
    const args = resolved.captureContent
      ? safeJson(captured?.params ?? event.toolInput ?? event.paramsSummary)
      : undefined;
    const tool = runIsolated(() =>
      turn.startTool({
        name: event.toolName ?? captured?.toolName ?? "unknown",
        toolCallId,
        args,
      }),
    );
    setBoundedMap(registries.tools, toolCallId, tool, MAX_ENTRIES);
  }

  function onToolFinalize(event: any, status: "ok" | "error", errorType: string | undefined): void {
    const toolCallId: string | undefined = event.toolCallId;
    if (!toolCallId) return;
    const tool = registries.tools.get(toolCallId);
    if (!tool) return;
    if (resolved?.captureContent) {
      const captured = lookupToolCall(params.hookState, toolCallId).result;
      const result = safeJson(captured?.result ?? event.toolOutput);
      if (result !== undefined) tool.result = result;
    }
    tool.end(
      status === "error"
        ? { error: new Error(errorType ?? "tool.execution.error") }
        : undefined,
    );
    registries.tools.delete(toolCallId);
    params.hookState.toolCallArgs.delete(toolCallId);
    params.hookState.toolCallResults.delete(toolCallId);
  }

  function safeJson(v: unknown): string | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  }

  function shapeMessages(
    cap: {
      input?: { systemPrompt?: string; prompt: string; historyMessages?: unknown[] };
      output?: { assistantTexts: string[]; lastAssistant?: unknown; usage?: any };
    },
    captureContent: boolean,
  ): { input: Message[]; output: Message[]; usage?: Usage } {
    const out: { input: Message[]; output: Message[]; usage?: Usage } = { input: [], output: [] };
    if (captureContent && cap.input) {
      if (cap.input.systemPrompt) {
        out.input.push({ role: "system", content: cap.input.systemPrompt });
      }
      if (Array.isArray(cap.input.historyMessages)) {
        for (const m of cap.input.historyMessages) {
          if (m && typeof m === "object" && "role" in m && "content" in m) {
            out.input.push(m as Message);
          }
        }
      }
      if (cap.input.prompt) {
        out.input.push({ role: "user", content: cap.input.prompt });
      }
    }
    if (captureContent && cap.output) {
      for (const t of cap.output.assistantTexts) {
        out.output.push({ role: "assistant", content: t });
      }
    }
    // Usage tokens are always recorded regardless of captureContent — only
    // the message content is gated by the flag.
    const u = cap.output?.usage;
    if (u) {
      out.usage = {
        inputTokens: typeof u.input === "number" ? u.input : undefined,
        outputTokens: typeof u.output === "number" ? u.output : undefined,
        reasoningTokens: typeof u.reasoning === "number" ? u.reasoning : undefined,
        cacheReadInputTokens: typeof u.cacheRead === "number" ? u.cacheRead : undefined,
        cacheCreationInputTokens: typeof u.cacheWrite === "number" ? u.cacheWrite : undefined,
      };
    }
    return out;
  }

  return { service, registries, getStatus, handlers };
}

export function renderStatus(plugin: WeavePlugin): string {
  return formatStatus(plugin.getStatus());
}
