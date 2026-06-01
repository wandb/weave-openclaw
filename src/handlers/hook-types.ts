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

// Convenience alias for the llm_output usage payload, so consumers map its
// already-typed fields instead of re-checking shapes at runtime.
export type LlmOutputUsage = HookEvent<"llm_output">["usage"];
