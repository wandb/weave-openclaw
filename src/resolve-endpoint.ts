import type { RawWeavePluginConfig } from "./types.js";

const AGENTS_TRACES_PATH = "/agents/otel/v1/traces";

/**
 * Build the full agents-OTel traces URL. Weave does not auto-append the
 * per-signal path; the client must send the full URL.
 *
 * - cloud:      https://trace.wandb.ai/agents/otel/v1/traces
 * - dedicated:  https://<subdomain>.wandb.io/traces/agents/otel/v1/traces
 *
 * Note the dedicated URL pattern includes an extra "/traces" segment before
 * "/agents/otel/v1/traces" — this is verified from the public Weave docs.
 *
 * Throws if config is incomplete (e.g. dedicated tier without subdomain).
 */
export function resolveWeaveEndpoint(cfg: RawWeavePluginConfig): string {
  if (cfg.endpoint) {
    const explicit = cfg.endpoint.trim().replace(/\/+$/, "");
    if (!explicit.endsWith(AGENTS_TRACES_PATH)) {
      throw new Error(
        `weave.endpoint must end with ${AGENTS_TRACES_PATH}; got ${explicit}`,
      );
    }
    return explicit;
  }

  const tier = cfg.tier ?? "cloud";
  if (tier === "cloud") {
    return `https://trace.wandb.ai${AGENTS_TRACES_PATH}`;
  }

  const subdomain = cfg.subdomain?.trim();
  if (!subdomain) {
    throw new Error(
      "weave.subdomain is required when tier=dedicated (e.g. 'acme' for acme.wandb.io)",
    );
  }
  if (!/^[a-z0-9-]+$/i.test(subdomain)) {
    throw new Error(
      `weave.subdomain has invalid characters: ${subdomain}. Expected [a-z0-9-]+`,
    );
  }
  return `https://${subdomain}.wandb.io/traces${AGENTS_TRACES_PATH}`;
}
