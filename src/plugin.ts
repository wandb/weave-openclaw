// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { flushOTel, init as weaveInit, login as weaveLogin } from "weave";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { WeaveHookState } from "./state/hook-state.js";
import { resolveConfig, type RawConfig, type ResolvedConfig } from "./config/config.js";
import { readWandbBaseUrl } from "./config/env.js";
import { createRegistries, type Registries } from "./state/registries.js";
import { formatStatus, type StatusSnapshot } from "./config/status.js";
import { PACKAGE_VERSION } from "./config/version.js";
import type { HandlerDeps, HandlerLogger } from "./handlers/deps.js";
import type { HookHandlers } from "./handlers/hook-types.js";
import { BoundedMap } from "./util/bounded-map.js";
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

const WANDB_CLOUD_API_BASE_URL = "https://api.wandb.ai";
const WANDB_CLOUD_UI_BASE_URL = "https://wandb.ai";

type CreateWeavePluginParams = {
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
  const costByRun = new BoundedMap<string, number>();
  const pendingCompactionByRun = new BoundedMap<string, { itemsBefore: number }>();
  const runIdBySession = new BoundedMap<string, string>();
  const pendingToolFinalize = new BoundedMap<
    string,
    { status: "ok" | "error"; errorType?: string; runId?: string }
  >();
  let logger: HandlerLogger | undefined;

  const deps: HandlerDeps = {
    registries,
    hookState: params.hookState,
    getResolved: () => resolved,
    getLogger: () => logger,
    costByRun,
    pendingCompactionByRun,
    runIdBySession,
    pendingToolFinalize,
  };

  function resetTransientState(): void {
    registries.sessions.clear();
    registries.turns.clear();
    registries.calls.clear();
    registries.tools.clear();
    registries.subagents.clear();
    params.hookState.chatCallsByRun.clear();
    params.hookState.assistantOutputByCall.clear();
    costByRun.clear();
    pendingCompactionByRun.clear();
    runIdBySession.clear();
    pendingToolFinalize.clear();
  }

  const service: OpenClawPluginService = {
    id: "weave",
    async start(ctx) {
      logger = ctx.logger;
      if (lifecycle === "running") resetTransientState();
      resolved = undefined;
      startedAt = undefined;
      lifecycle = "not-started";
      lifecycleDetail = undefined;
      let cfg: ResolvedConfig;
      try {
        cfg = await resolveConfig((params.pluginConfig ?? {}) as RawConfig, { config: ctx.config });
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
        try {
          await weaveLogin(cfg.apiKey, readWandbBaseUrl());
        } catch (err) {
          lifecycle = "config-error";
          lifecycleDetail = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`weave: login failed: ${lifecycleDetail}`);
          return;
        }
      }
      try {
        const client = await weaveInit(cfg.projectId, {
          genai: { batchOptions: { scheduledDelayMillis: cfg.flushIntervalMs } },
        });
        // init() fills the W&B default entity for a bare project; use the resolved id.
        cfg.projectId = client.projectId;
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
      if (cfg.captureContent) {
        ctx.logger.info(
          "weave: captureContent is on; full conversation content (prompts, replies, tool inputs and results) " +
            "is sent to W&B unredacted. Set captureContent=false to export only trace structure and token/cost totals.",
        );
      }
    },
    async stop(ctx) {
      lifecycle = "stopped";
      try {
        await flushOTel();
      } catch (err) {
        ctx.logger.warn(
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
          ? `${WANDB_CLOUD_UI_BASE_URL}/${resolved.projectId}/weave/agents`
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
  const { onRunStarted, onRunFinalize, onRunAttempt } = createRunDiagnosticHandlers(deps);
  const { onChatStart, onChatFinalize } = createChatDiagnosticHandlers(deps);
  const { onToolStart, onToolFinalize, onToolLoop } = createToolDiagnosticHandlers(deps);
  const { onModelUsage } = createUsageDiagnosticHandlers(deps);
  const { onContextAssembled } = createContextDiagnosticHandlers(deps);

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
      // Drop events arriving before start() resolves config.
      if (!resolved) return;
      switch (event.type) {
        case "run.started":
          return onRunStarted(event);
        case "run.completed":
          return onRunFinalize(event);
        case "run.attempt":
          return onRunAttempt(event);
        case "model.call.started":
          return onChatStart(event);
        case "model.call.completed":
          return onChatFinalize(event, "ok", undefined);
        case "model.call.error":
          return onChatFinalize(event, "error", event.errorCategory);
        case "tool.execution.started":
          return onToolStart(event);
        case "tool.execution.completed":
          return onToolFinalize(event, "ok", undefined);
        case "tool.execution.error":
          return onToolFinalize(event, "error", event.errorCategory);
        case "tool.execution.blocked":
          return onToolFinalize(event, "error", "blocked");
        case "tool.loop":
          return onToolLoop(event);
        case "model.usage":
          return onModelUsage(event);
        case "context.assembled":
          return onContextAssembled(event);
      }
    },
  };

  return { service, registries, getStatus, handlers };
}

export function renderStatus(plugin: WeavePlugin): string {
  return formatStatus(plugin.getStatus());
}
