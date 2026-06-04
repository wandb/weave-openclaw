// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

// Per-hook event/ctx types recovered from OpenClawPluginApi["on"] via a TS
// instantiation expression (avoids deep-importing the internal handler map).

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type OnFn = OpenClawPluginApi["on"];
declare const _onFn: OnFn;

export type HookName = Parameters<OnFn>[0];
export type HookHandler<K extends HookName> = Parameters<typeof _onFn<K>>[1];
export type HookEvent<K extends HookName> = Parameters<HookHandler<K>>[0];
export type HookCtx<K extends HookName> = Parameters<HookHandler<K>>[1];

export type HookHandlers = { [K in HookName]?: HookHandler<K> };

// OpenClaw's per-call token usage shape (input/output/cache counts), recovered from
// the llm_output event type. The one place this shape is named; reused by the
// assistant-output capture and the toUsage mapper instead of re-declaring it.
export type LlmUsage = HookEvent<"llm_output">["usage"];
