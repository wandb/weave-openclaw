import { describe, expect, test } from "vitest";
import { resolveWeaveEndpoint } from "./resolve-endpoint.js";

describe("resolveWeaveEndpoint", () => {
  test("cloud (default tier) returns trace.wandb.ai/agents/otel/v1/traces", () => {
    expect(
      resolveWeaveEndpoint({ entity: "acme", project: "agents" }),
    ).toBe("https://trace.wandb.ai/agents/otel/v1/traces");
  });

  test("cloud (explicit tier) returns trace.wandb.ai", () => {
    expect(
      resolveWeaveEndpoint({ entity: "acme", project: "agents", tier: "cloud" }),
    ).toBe("https://trace.wandb.ai/agents/otel/v1/traces");
  });

  test("dedicated tier requires subdomain", () => {
    expect(() =>
      resolveWeaveEndpoint({ entity: "x", project: "y", tier: "dedicated" }),
    ).toThrowError(/subdomain is required/);
  });

  test("dedicated tier composes <subdomain>.wandb.io/traces/agents/otel/v1/traces", () => {
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        tier: "dedicated",
        subdomain: "acme",
      }),
    ).toBe("https://acme.wandb.io/traces/agents/otel/v1/traces");
  });

  test("dedicated subdomain rejects invalid characters", () => {
    expect(() =>
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        tier: "dedicated",
        subdomain: "bad subdomain!",
      }),
    ).toThrowError(/invalid characters/);
  });

  test("dedicated subdomain accepts hyphens, digits, mixed case", () => {
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        tier: "dedicated",
        subdomain: "acme-prod-2",
      }),
    ).toBe("https://acme-prod-2.wandb.io/traces/agents/otel/v1/traces");
  });

  test("explicit endpoint overrides tier composition", () => {
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        tier: "dedicated",
        subdomain: "acme",
        endpoint: "https://custom.example.com/agents/otel/v1/traces",
      }),
    ).toBe("https://custom.example.com/agents/otel/v1/traces");
  });

  test("explicit endpoint strips trailing slashes", () => {
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        endpoint: "https://custom.example.com/agents/otel/v1/traces///",
      }),
    ).toBe("https://custom.example.com/agents/otel/v1/traces");
  });

  test("explicit endpoint must end with /agents/otel/v1/traces", () => {
    expect(() =>
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        endpoint: "https://custom.example.com/v1/traces",
      }),
    ).toThrowError(/must end with \/agents\/otel\/v1\/traces/);
  });
});
