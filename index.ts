// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createWeaveHookState } from "./src/state/hook-state.js";
import { createWeavePlugin, type WeavePlugin } from "./src/plugin.js";

// register(api) can run multiple times (setup/runtime, hot-reload); cache the
// instance + subscription on globalThis so a re-import doesn't make a stale duplicate.
const PLUGIN_GLOBAL_KEY = Symbol.for("weave-openclaw.plugin");
const DIAGNOSTIC_SUBSCRIBED_KEY = Symbol.for("weave-openclaw.diagnosticSubscribed");

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
    "Track OpenClaw agent sessions in W&B Weave for observability and debugging.",
  register(api) {
    const plugin = getOrCreateSharedPlugin(api.pluginConfig);

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
  },
});
