import { type AddressInfo, createServer, type IncomingMessage, type Server } from "node:http";
import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createWeaveService } from "./service.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const ROOT_SPAN_ID = "1111111111111111";

function makeCtx(): OpenClawPluginServiceContext {
  return {
    config: {} as never,
    stateDir: "/tmp/openclaw-plugin-weave-smoke",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as never,
  } as OpenClawPluginServiceContext;
}

async function flushAsyncDiagnostics(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

type Capture = { headers: IncomingMessage["headers"]; body: Buffer };

function startCaptureServer(): Promise<{
  url: string;
  getCapture: () => Capture | null;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    let capture: Capture | null = null;
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        capture = { headers: req.headers, body: Buffer.concat(chunks) };
        res.writeHead(200, { "Content-Type": "application/x-protobuf" });
        // Empty ExportTraceServiceResponse — accepted by the OTLP client.
        res.end(Buffer.from([]));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}/agents/otel/v1/traces`;
      resolve({
        url,
        getCapture: () => capture,
        close() {
          return new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

describe("smoke: HTTP loopback wire format", () => {
  let server: Awaited<ReturnType<typeof startCaptureServer>>;

  beforeEach(async () => {
    resetDiagnosticEventsForTest();
    server = await startCaptureServer();
  });

  afterEach(async () => {
    resetDiagnosticEventsForTest();
    await server.close();
  });

  test("constructed exporter sends proto + auth headers + project_id", async () => {
    process.env.WANDB_API_KEY = "smoke-test-key";
    const { service } = createWeaveService({
      pluginConfig: {
        entity: "smoke",
        project: "test",
        agentName: "smoke-agent",
        endpoint: server.url,
        flushIntervalMs: 1000,
      },
    });
    const ctx = makeCtx();
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "r-smoke",
      harnessId: "smoke-agent",
      sessionKey: "conv-smoke",
      trace: {
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        traceFlags: "01",
      },
    } as never);
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "r-smoke",
      harnessId: "smoke-agent",
      durationMs: 100,
      outcome: "completed",
      trace: {
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        traceFlags: "01",
      },
    } as never);
    await flushAsyncDiagnostics();
    await service.stop?.(ctx); // forces flush

    delete process.env.WANDB_API_KEY;

    const cap = server.getCapture();
    expect(cap).not.toBeNull();
    expect(cap!.headers["content-type"]).toBe("application/x-protobuf");
    // Authorization Basic uses base64("api:smoke-test-key").
    const expected = `Basic ${Buffer.from("api:smoke-test-key").toString("base64")}`;
    expect(cap!.headers.authorization).toBe(expected);
    expect(cap!.headers["wandb-api-key"]).toBe("smoke-test-key");
    expect(cap!.headers.project_id).toBe("smoke/test");
    expect(cap!.body.length).toBeGreaterThan(0);
  }, 10_000);
});
