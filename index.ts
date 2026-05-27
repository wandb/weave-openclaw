// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createWeaveHookState } from "./src/state/hook-state.js";
import { createWeavePlugin, renderStatus, type WeavePlugin } from "./src/plugin.js";

// OpenClaw's loader can invoke `register(api)` multiple times for the same
// plugin (setup phase + runtime phase, hot-reload, plugin re-registration).
// Cache the plugin instance + diagnostic-listener subscription on globalThis,
// not module scope: a module re-import would create a fresh module and hand
// out a fresh plugin instance with empty registries, while the old instance's
// diagnostic listener would still be live but holding stale state. The plugin
// instance owns its hookState; one singleton entry on globalThis covers both.
//
// The `.v1` suffix on these Symbol keys is the version of the singleton
// contract (shape of the cached plugin instance), independent of the plugin's
// package version. Bump it only if the cached shape changes incompatibly.
const PLUGIN_GLOBAL_KEY = Symbol.for("weave-openclaw.plugin.v1");
const DIAGNOSTIC_SUBSCRIBED_KEY = Symbol.for("weave-openclaw.diagnosticSubscribed.v1");

function getOrCreateSharedPlugin(pluginConfig: unknown): WeavePlugin {
  const g = globalThis as Record<PropertyKey, unknown>;
  const cached = g[PLUGIN_GLOBAL_KEY] as WeavePlugin | undefined;
  if (cached) return cached;
  const plugin = createWeavePlugin({ pluginConfig, hookState: createWeaveHookState() });
  Object.defineProperty(g, PLUGIN_GLOBAL_KEY, {
    value: plugin,
    writable: false,
    configurable: true,
    enumerable: false,
  });
  if (plugin.handlers.diagnostic && !g[DIAGNOSTIC_SUBSCRIBED_KEY]) {
    onInternalDiagnosticEvent(plugin.handlers.diagnostic);
    Object.defineProperty(g, DIAGNOSTIC_SUBSCRIBED_KEY, {
      value: true,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  }
  return plugin;
}

export default definePluginEntry({
  id: "weave",
  name: "W&B Weave",
  description:
    "Emit OpenClaw agent diagnostic events to W&B Weave's Agents OTel endpoint via the weave.genai SDK.",
  register(api) {
    if (typeof api.on !== "function" || typeof api.registerService !== "function") {
      // eslint-disable-next-line no-console
      console.error("[weave] OpenClaw plugin SDK missing required surface; skipping.");
      return;
    }

    const plugin = getOrCreateSharedPlugin(api.pluginConfig);

    // Inline lambdas at each api.on(...) get per-hook event/ctx typing
    // inferred from OpenClawPluginApi.on's generic signature
    // (<K extends PluginHookName>(name: K, handler: PluginHookHandlerMap[K])).
    // The handler factories still accept (event: any) internally because
    // PluginHookHandlerMap and the per-event types aren't re-exported from
    // openclaw's public surface, but the wrong-hook-wrong-handler class of
    // bug is caught here regardless.
    const hooks = plugin.handlers.hook;
    api.on("session_start", (event, ctx) => hooks.session_start?.(event, ctx));
    api.on("session_end", (event, ctx) => hooks.session_end?.(event, ctx));
    api.on("model_call_started", (event, ctx) => hooks.model_call_started?.(event, ctx));
    api.on("llm_input", (event, ctx) => hooks.llm_input?.(event, ctx));
    api.on("llm_output", (event, ctx) => hooks.llm_output?.(event, ctx));
    api.on("before_tool_call", (event, ctx) => hooks.before_tool_call?.(event, ctx));
    api.on("after_tool_call", (event, ctx) => hooks.after_tool_call?.(event, ctx));
    api.on("subagent_spawned", (event, ctx) => hooks.subagent_spawned?.(event, ctx));
    api.on("subagent_ended", (event, ctx) => hooks.subagent_ended?.(event, ctx));
    api.on("before_compaction", (event, ctx) => hooks.before_compaction?.(event, ctx));
    api.on("after_compaction", (event, ctx) => hooks.after_compaction?.(event, ctx));
    api.on("agent_end", (event, ctx) => hooks.agent_end?.(event, ctx));
    api.on("message_received", (event, ctx) => hooks.message_received?.(event, ctx));

    api.registerService(plugin.service);

    api.registerCommand({
      name: "weave",
      description: "Show W&B Weave plugin status",
      acceptsArgs: true,
      handler: () => ({ text: renderStatus(plugin) }),
    });
  },
});
