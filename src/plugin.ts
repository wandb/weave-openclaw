// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { flushOTel, init as weaveInit } from "weave";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import type { WeaveHookState } from "./hook-state.js";
import { resolveConfig, type RawConfig, type ResolvedConfig } from "./config.js";
import { createRegistries, type Registries } from "./registries.js";
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

  return { service, registries, getStatus, handlers: { hook: {} } };
}

export function renderStatus(plugin: WeavePlugin): string {
  return formatStatus(plugin.getStatus());
}
