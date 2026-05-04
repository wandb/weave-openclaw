/**
 * Preflight check that the host OpenClaw plugin SDK exposes the surface this
 * plugin requires. Today: `api.on` and `api.registerService` must be functions.
 *
 * If the host is too old (or somehow not the OpenClaw SDK at all), the
 * standard failure mode is `undefined is not a function` deep inside hook
 * subscription. This preflight surfaces a clear, actionable error message
 * instead.
 *
 * Returns a discriminated union so callers can `if (!result.ok)` and bail
 * early without throwing — `register()` shouldn't throw because that crashes
 * plugin loading and hides the message.
 */
export type SdkCompatResult =
  | { ok: true }
  | { ok: false; message: string };

export const REQUIRED_PLUGIN_API = ">=2026.4.25";

export function checkSdkCompat(api: unknown): SdkCompatResult {
  if (!api || typeof api !== "object") {
    return {
      ok: false,
      message: `openclaw-plugin-weave: incompatible plugin SDK (api is ${typeof api}). This plugin requires pluginApi ${REQUIRED_PLUGIN_API}.`,
    };
  }
  const a = api as Record<string, unknown>;
  if (typeof a.on !== "function") {
    return {
      ok: false,
      message: `openclaw-plugin-weave: incompatible plugin SDK (api.on is not a function). This plugin requires pluginApi ${REQUIRED_PLUGIN_API}; please upgrade OpenClaw.`,
    };
  }
  if (typeof a.registerService !== "function") {
    return {
      ok: false,
      message: `openclaw-plugin-weave: incompatible plugin SDK (api.registerService is not a function). This plugin requires pluginApi ${REQUIRED_PLUGIN_API}; please upgrade OpenClaw.`,
    };
  }
  return { ok: true };
}
