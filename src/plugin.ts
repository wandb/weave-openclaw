// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { flushOTel, init as weaveInit, runIsolated, startSession, startTurn } from "weave";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import type { WeaveHookState } from "./hook-state.js";
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

  handlers.diagnostic = (event, meta) => {
    if (!meta.trusted) return;
    if (event.type === "run.started") return onRunStarted(event);
    if (event.type === "run.completed") return onRunFinalize(event);
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

  return { service, registries, getStatus, handlers };
}

export function renderStatus(plugin: WeavePlugin): string {
  return formatStatus(plugin.getStatus());
}
