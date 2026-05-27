// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

/**
 * Per-hook event/context type aliases derived from `OpenClawPluginApi["on"]`.
 *
 * `OpenClawPluginApi["on"]` is typed
 * `<K extends PluginHookName>(name: K, handler: PluginHookHandlerMap[K]) => void`.
 * We use a TS 4.7+ instantiation expression (`typeof _onFn<K>`) to recover
 * the K-binding that plain `Parameters<...>` collapses, then extract the
 * handler and its event/ctx params.
 *
 * Doing it this way means handler files don't have to deep-import the
 * internal `PluginHookHandlerMap` type, which isn't re-exported from
 * `openclaw/plugin-sdk/plugin-entry`.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type OnFn = OpenClawPluginApi["on"];
declare const _onFn: OnFn;

export type HookName = Parameters<OnFn>[0];
export type HookHandler<K extends HookName> = Parameters<typeof _onFn<K>>[1];
export type HookEvent<K extends HookName> = Parameters<HookHandler<K>>[0];
export type HookCtx<K extends HookName> = Parameters<HookHandler<K>>[1];

/**
 * Union of every handler this plugin can register. Used by
 * `WeavePlugin.handlers.hook` so consumers see typed entries instead of
 * `Record<string, (event: any, ctx?: any) => void>`.
 */
export type HookHandlers = { [K in HookName]?: HookHandler<K> };
