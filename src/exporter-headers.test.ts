import { describe, expect, test } from "vitest";
import { buildExporterHeaders } from "./exporter-headers.js";

describe("buildExporterHeaders", () => {
  test("encodes 'api:<KEY>' as base64 in Authorization Basic header", () => {
    const headers = buildExporterHeaders("test-key-123", "acme/agents");
    // base64("api:test-key-123") = "YXBpOnRlc3Qta2V5LTEyMw=="
    expect(headers.Authorization).toBe("Basic YXBpOnRlc3Qta2V5LTEyMw==");
  });

  test("includes project_id verbatim", () => {
    const headers = buildExporterHeaders("k", "team-a/proj-b");
    expect(headers.project_id).toBe("team-a/proj-b");
  });

  test("Authorization header does NOT contain the raw key in plain text", () => {
    const apiKey = "sk-live-abcd-NEVER-IN-PLAIN";
    const headers = buildExporterHeaders(apiKey, "x/y");
    expect(headers.Authorization).not.toContain(apiKey);
  });

  test("includes `wandb-api-key` header for belt-and-suspenders compatibility", () => {
    const headers = buildExporterHeaders("k123", "x/y");
    expect(headers["wandb-api-key"]).toBe("k123");
  });

  test("decoding the Authorization header recovers the key", () => {
    const apiKey = "secret-7";
    const headers = buildExporterHeaders(apiKey, "x/y");
    const m = /^Basic (.+)$/.exec(headers.Authorization);
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m![1], "base64").toString("utf8");
    expect(decoded).toBe(`api:${apiKey}`);
  });
});
