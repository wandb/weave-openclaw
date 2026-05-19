// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getSharedWeaveHookState } from "./src/hook-state.js";
import { checkSdkCompat } from "./src/sdk-compat.js";
import { createWeaveService } from "./src/service.js";
import { formatWeaveStatus } from "./src/status-format.js";

export default definePluginEntry({
  id: "weave",
  name: "W&B Weave",
  description:
    "Emit OpenClaw agent diagnostic events as OpenTelemetry spans to W&B Weave's Agents OTel endpoint (weave.* namespace, /agents/otel/v1/traces).",
  register(api) {
    // Preflight: ensure the host SDK exposes the surface we need. Older
    // OpenClaw versions silently produce `undefined is not a function` deep
    // inside hook subscription; this catches the incompatibility upfront.
    const compat = checkSdkCompat(api);
    if (!compat.ok) {
      // No ctx.logger yet at register time; use console.error which the
      // gateway captures with the [weave] prefix for identification.
      // eslint-disable-next-line no-console
      console.error(`[weave] ${compat.message}`);
      return;
    }

    // Shared hook-state instance. Hook subscriptions wired in subsequent PRs
    // populate this; the service reads it when finalizing spans.
    const hookState = getSharedWeaveHookState();

    const { service, getStatus } = createWeaveService({
      pluginConfig: api.pluginConfig,
      hookState,
    });

    api.registerService(service);

    // Operator-facing "did it work?" command. Renders the live snapshot from
    // getStatus() — endpoint, project, auth source, export counters, and a
    // dashboard link. Surfaces lifecycle (disabled / config-error / running /
    // stopped) so a misconfiguration is visible in chat without grepping the
    // gateway log for `weave: exporting to ...`.
    api.registerCommand({
      name: "weave",
      description: "Show W&B Weave plugin status (endpoint, export counters, last error).",
      acceptsArgs: true,
      handler: (ctx) => {
        const first = (ctx.args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        if (first === "" || first === "status") {
          return { text: formatWeaveStatus(getStatus()) };
        }
        if (first === "help") {
          return {
            text: [
              "Usage: /weave [status|help]",
              "  status   show plugin lifecycle, endpoint, and export counters (default)",
              "  help     show this message",
            ].join("\n"),
          };
        }
        return {
          text: `Unknown /weave subcommand: \`${first}\`. Try \`/weave status\` or \`/weave help\`.`,
        };
      },
    });
  },
});
