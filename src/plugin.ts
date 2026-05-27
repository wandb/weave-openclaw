// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { flushOTel, init as weaveInit } from "weave";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { WeaveHookState } from "./state/hook-state.js";
import { resolveConfig, type RawConfig, type ResolvedConfig } from "./config/config.js";
import { readWandbApiKey, readWandbBaseUrl, setWandbApiKey } from "./config/env.js";
import { createRegistries, type Registries } from "./state/registries.js";
import { formatStatus, type StatusSnapshot } from "./config/status.js";
import { PACKAGE_VERSION } from "./config/version.js";
import type { HandlerDeps, HandlerLogger } from "./handlers/deps.js";
import type { HookHandlers } from "./handlers/hook-types.js";
import { createSessionHookHandlers } from "./handlers/hooks/session.js";
import { createTurnHookHandlers } from "./handlers/hooks/turn.js";
import { createToolHookHandlers } from "./handlers/hooks/tool.js";
import { createLlmHookHandlers } from "./handlers/hooks/llm.js";
import { createSubagentHookHandlers } from "./handlers/hooks/subagent.js";
import { createCompactionHookHandlers } from "./handlers/hooks/compaction.js";
import { createRunDiagnosticHandlers } from "./handlers/diagnostic/run.js";
import { createChatDiagnosticHandlers } from "./handlers/diagnostic/chat.js";
import { createToolDiagnosticHandlers } from "./handlers/diagnostic/tool.js";
import { createUsageDiagnosticHandlers } from "./handlers/diagnostic/usage.js";
import { createContextDiagnosticHandlers } from "./handlers/diagnostic/context.js";

// W&B Cloud's default API host. WANDB_BASE_URL is set to this (or unset) for
// the public cloud install; dedicated installs override it to their own host.
const WANDB_CLOUD_API_BASE_URL = "https://api.wandb.ai";

// The Weave UI uses a sibling host to the API base. We only know how to derive
// a UI URL for W&B Cloud; dedicated installs go through a different routing
// scheme that the plugin can't infer here, so we leave uiUrl undefined and let
// the operator look it up themselves.
const WANDB_CLOUD_UI_BASE_URL = "https://wandb.ai";

export type CreateWeavePluginParams = {
  pluginConfig?: unknown;
  hookState: WeaveHookState;
};

export type WeavePlugin = {
  service: OpenClawPluginService;
  registries: Registries;
  getStatus: () => StatusSnapshot;
  handlers: {
    hook: HookHandlers;
    diagnostic?: (event: DiagnosticEventPayload, meta: DiagnosticEventMetadata) => void;
  };
};

export function createWeavePlugin(params: CreateWeavePluginParams): WeavePlugin {
  const registries = createRegistries();
  let resolved: ResolvedConfig | undefined;
  let lifecycle: StatusSnapshot["lifecycle"] = "not-started";
  let lifecycleDetail: string | undefined;
  let startedAt: number | undefined;
  const costByRun = new Map<string, number>();
  const pendingCompactionByRun = new Map<string, { itemsBefore: number }>();
  let logger: HandlerLogger | undefined;

  const deps: HandlerDeps = {
    registries,
    hookState: params.hookState,
    getResolved: () => resolved,
    getLogger: () => logger,
    costByRun,
    pendingCompactionByRun,
  };

  function resetTransientState(): void {
    registries.sessions.clear();
    registries.turns.clear();
    registries.calls.clear();
    registries.tools.clear();
    registries.subagents.clear();
    params.hookState.chatCallsByRun.clear();
    params.hookState.assistantOutputByRun.clear();
    costByRun.clear();
    pendingCompactionByRun.clear();
  }

  const service: OpenClawPluginService = {
    id: "weave",
    async start(ctx) {
      logger = ctx.logger;
      // If start() is called without a prior stop(), drop accumulated state.
      if (lifecycle === "running") resetTransientState();
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
        setWandbApiKey(cfg.apiKey);
      } else if (!readWandbApiKey()) {
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
      resetTransientState();
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
      const wandbBase = readWandbBaseUrl();
      const uiUrl =
        !wandbBase || wandbBase === WANDB_CLOUD_API_BASE_URL
          ? `${WANDB_CLOUD_UI_BASE_URL}/${resolved.projectId}/weave`
          : undefined;
      snap.config = {
        projectId: resolved.projectId,
        serviceName: resolved.serviceName,
        agentVersion: resolved.agentVersion,
        flushIntervalMs: resolved.flushIntervalMs,
        captureContent: resolved.captureContent,
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

  const sessionHooks = createSessionHookHandlers(deps);
  const turnHooks = createTurnHookHandlers(deps);
  const toolHooks = createToolHookHandlers(deps);
  const llmHooks = createLlmHookHandlers(deps);
  const subagentHooks = createSubagentHookHandlers(deps);
  const compactionHooks = createCompactionHookHandlers(deps);
  const runDiag = createRunDiagnosticHandlers(deps);
  const chatDiag = createChatDiagnosticHandlers(deps);
  const toolDiag = createToolDiagnosticHandlers(deps);
  const usageDiag = createUsageDiagnosticHandlers(deps);
  const contextDiag = createContextDiagnosticHandlers(deps);

  const handlers: WeavePlugin["handlers"] = {
    hook: {
      ...sessionHooks,
      ...turnHooks,
      ...toolHooks,
      ...llmHooks,
      ...subagentHooks,
      ...compactionHooks,
    },
    diagnostic(event, meta) {
      if (!meta.trusted) return;
      // Single boundary check: events arriving between register() (when this
      // listener subscribes) and start() (when config resolves) drop here
      // instead of each handler re-checking. After resolved is set every
      // case below can safely look up state without re-guarding.
      if (!resolved) return;
      switch (event.type) {
        case "run.started":
          return runDiag.onRunStarted(event);
        case "run.completed":
          return runDiag.onRunFinalize(event);
        case "run.attempt":
          return runDiag.onRunAttempt(event);
        case "model.call.started":
          return chatDiag.onChatStart(event);
        case "model.call.completed":
          return chatDiag.onChatFinalize(event, "ok", undefined);
        case "model.call.error":
          return chatDiag.onChatFinalize(event, "error", event.errorCategory);
        case "tool.execution.started":
          return toolDiag.onToolStart(event);
        case "tool.execution.completed":
          return toolDiag.onToolFinalize(event, "ok", undefined);
        case "tool.execution.error":
          return toolDiag.onToolFinalize(event, "error", event.errorCategory);
        case "tool.execution.blocked":
          return toolDiag.onToolFinalize(event, "error", "blocked");
        case "tool.loop":
          return toolDiag.onToolLoop(event);
        case "model.usage":
          return usageDiag.onModelUsage(event);
        case "context.assembled":
          return contextDiag.onContextAssembled(event);
      }
    },
  };

  return { service, registries, getStatus, handlers };
}

export function renderStatus(plugin: WeavePlugin): string {
  return formatStatus(plugin.getStatus());
}
