/**
 * Build the headers attached to every outbound OTLP request to W&B Weave's
 * `/agents/otel/v1/traces` endpoint.
 *
 * The Weave trace server accepts two auth forms (verified in the agents OTel
 * handler): it checks for the `wandb-api-key` header first and falls back to
 * `Authorization: Basic base64("api:<KEY>")` when the former is absent. We
 * send BOTH:
 *   - `Authorization: Basic ...` — canonical/contract form documented for
 *     Weave's OTel endpoint and used by Vercel AI SDK, Google ADK, and the
 *     public Weave docs. This is what survives if the alternate header is
 *     ever deprecated.
 *   - `wandb-api-key: <KEY>` — alternate routing path that some W&B
 *     deployments check first; included for belt-and-suspenders compatibility
 *     so a server that only inspects this header still authenticates.
 *
 * `project_id` (lowercase) ties spans to a specific W&B project for ingest
 * routing — required when spans don't carry `wandb.entity`/`wandb.project`
 * resource attributes. Format is `<entity>/<project>`.
 */
export function buildExporterHeaders(
  apiKey: string,
  projectId: string,
): Record<string, string> {
  const basic = Buffer.from(`api:${apiKey}`).toString("base64");
  return {
    Authorization: `Basic ${basic}`,
    "wandb-api-key": apiKey,
    project_id: projectId,
  };
}
