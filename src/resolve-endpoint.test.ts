// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveWeaveEndpoint } from "./resolve-endpoint.js";

describe("resolveWeaveEndpoint", () => {
  const prevBaseUrl = process.env.WANDB_BASE_URL;
  const prevTraceUrl = process.env.WF_TRACE_SERVER_URL;

  beforeEach(() => {
    delete process.env.WANDB_BASE_URL;
    delete process.env.WF_TRACE_SERVER_URL;
  });

  afterEach(() => {
    if (prevBaseUrl !== undefined) process.env.WANDB_BASE_URL = prevBaseUrl;
    else delete process.env.WANDB_BASE_URL;
    if (prevTraceUrl !== undefined)
      process.env.WF_TRACE_SERVER_URL = prevTraceUrl;
    else delete process.env.WF_TRACE_SERVER_URL;
  });

  test("default (no wandbBaseUrl, no env) returns cloud agents endpoint", () => {
    expect(resolveWeaveEndpoint({ entity: "acme", project: "agents" })).toBe(
      "https://trace.wandb.ai/agents/otel/v1/traces",
    );
  });

  test("explicit wandbBaseUrl=cloud-default routes to trace.wandb.ai", () => {
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        wandbBaseUrl: "https://api.wandb.ai",
      }),
    ).toBe("https://trace.wandb.ai/agents/otel/v1/traces");
  });

  test("wandbBaseUrl=dedicated composes <base>/traces/agents/otel/v1/traces", () => {
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        wandbBaseUrl: "https://acme.wandb.io",
      }),
    ).toBe("https://acme.wandb.io/traces/agents/otel/v1/traces");
  });

  test("trailing slashes on wandbBaseUrl are stripped", () => {
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        wandbBaseUrl: "https://acme.wandb.io///",
      }),
    ).toBe("https://acme.wandb.io/traces/agents/otel/v1/traces");
  });

  test("wandbBaseUrl without protocol throws", () => {
    expect(() =>
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        wandbBaseUrl: "acme.wandb.io",
      }),
    ).toThrowError(/must start with http/);
  });

  test("WANDB_BASE_URL env var is used when config field omitted", () => {
    process.env.WANDB_BASE_URL = "https://acme.wandb.io";
    expect(resolveWeaveEndpoint({ entity: "x", project: "y" })).toBe(
      "https://acme.wandb.io/traces/agents/otel/v1/traces",
    );
  });

  test("config field beats WANDB_BASE_URL env var", () => {
    process.env.WANDB_BASE_URL = "https://from-env.wandb.io";
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        wandbBaseUrl: "https://from-config.wandb.io",
      }),
    ).toBe("https://from-config.wandb.io/traces/agents/otel/v1/traces");
  });

  test("wfTraceServerUrl override bypasses wandbBaseUrl derivation", () => {
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        wandbBaseUrl: "https://acme.wandb.io",
        wfTraceServerUrl: "https://proxy.example.com/wf",
      }),
    ).toBe("https://proxy.example.com/wf/agents/otel/v1/traces");
  });

  test("WF_TRACE_SERVER_URL env var works when config field omitted", () => {
    process.env.WF_TRACE_SERVER_URL = "https://proxy.example.com/wf";
    expect(resolveWeaveEndpoint({ entity: "x", project: "y" })).toBe(
      "https://proxy.example.com/wf/agents/otel/v1/traces",
    );
  });

  test("config wfTraceServerUrl beats WF_TRACE_SERVER_URL env var", () => {
    process.env.WF_TRACE_SERVER_URL = "https://from-env/wf";
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        wfTraceServerUrl: "https://from-config/wf",
      }),
    ).toBe("https://from-config/wf/agents/otel/v1/traces");
  });

  test("wfTraceServerUrl ending in /agents/otel/v1/traces throws with hint", () => {
    expect(() =>
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        wfTraceServerUrl: "https://trace.wandb.ai/agents/otel/v1/traces",
      }),
    ).toThrowError(/trace-server URL.*NOT the full agents endpoint/);
  });

  test("wfTraceServerUrl strips trailing slashes before appending agents path", () => {
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        wfTraceServerUrl: "https://proxy.example.com/wf///",
      }),
    ).toBe("https://proxy.example.com/wf/agents/otel/v1/traces");
  });

  test("http:// (not https) accepted for proxies / dev installs", () => {
    expect(
      resolveWeaveEndpoint({
        entity: "x",
        project: "y",
        wfTraceServerUrl: "http://localhost:8080/wf",
      }),
    ).toBe("http://localhost:8080/wf/agents/otel/v1/traces");
  });
});
