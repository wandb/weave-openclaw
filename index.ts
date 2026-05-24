// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { getSharedWeaveHookState } from "./src/hook-state.js";
import { createWeavePlugin, renderStatus } from "./src/plugin.js";

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

    const hookState = getSharedWeaveHookState();
    const plugin = createWeavePlugin({ pluginConfig: api.pluginConfig, hookState });

    const hooks = plugin.handlers.hook;
    if (hooks.session_start) api.on("session_start", hooks.session_start);
    if (hooks.session_end) api.on("session_end", hooks.session_end);
    if (hooks.model_call_started) api.on("model_call_started", hooks.model_call_started);
    if (hooks.llm_input) api.on("llm_input", hooks.llm_input);
    if (hooks.llm_output) api.on("llm_output", hooks.llm_output);
    if (hooks.before_tool_call) api.on("before_tool_call", hooks.before_tool_call);
    if (hooks.after_tool_call) api.on("after_tool_call", hooks.after_tool_call);
    if (hooks.subagent_spawned) api.on("subagent_spawned", hooks.subagent_spawned);
    if (hooks.subagent_ended) api.on("subagent_ended", hooks.subagent_ended);
    if (hooks.before_compaction) api.on("before_compaction", hooks.before_compaction);
    if (hooks.after_compaction) api.on("after_compaction", hooks.after_compaction);
    if (hooks.agent_end) api.on("agent_end", hooks.agent_end);
    if (hooks.message_received) api.on("message_received", hooks.message_received);

    if (plugin.handlers.diagnostic) {
      onInternalDiagnosticEvent(plugin.handlers.diagnostic);
    }

    api.registerService(plugin.service);

    api.registerCommand({
      name: "weave",
      description: "Show W&B Weave plugin status",
      acceptsArgs: true,
      handler: () => ({ text: renderStatus(plugin) }),
    });
  },
});
