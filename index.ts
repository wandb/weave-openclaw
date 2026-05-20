// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { checkSdkCompat } from "./src/sdk-compat.js";

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
      // eslint-disable-next-line no-console
      console.error(`[weave] ${compat.message}`);
      return;
    }

    // Subsequent PRs in the stack wire in the OTel exporter service,
    // hook subscriptions, and the /weave status command.
  },
});
