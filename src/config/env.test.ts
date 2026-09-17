// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-openclaw

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDefaultApiKey } from "./env.js";

let home: string;
beforeEach(() => {
  mkdirSync(".context", { recursive: true });
  home = mkdtempSync(resolve(".context", "netrc-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("WANDB_API_KEY", "");
  vi.stubEnv("WANDB_BASE_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("default API key", () => {
  it("prefers the environment without reading netrc", async () => {
    vi.stubEnv("WANDB_API_KEY", "env-key");
    writeFileSync(join(home, ".netrc"), "machine api.wandb.ai login api password netrc-key\n");
    expect(await readDefaultApiKey()).toEqual({ value: "env-key", source: "WANDB_API_KEY env" });
  });
  it("reads only the configured host without modifying netrc", async () => {
    vi.stubEnv("WANDB_BASE_URL", "https://wandb.example");
    writeFileSync(join(home, ".netrc"), "machine api.wandb.ai login api password wrong\nmachine wandb.example login api password right\n");
    expect(await readDefaultApiKey()).toEqual({ value: "right", source: "~/.netrc" });
  });
  it("returns undefined for a missing file or host", async () => {
    expect(await readDefaultApiKey()).toBeUndefined();
    writeFileSync(join(home, ".netrc"), "machine other.example login api password wrong\n");
    expect(await readDefaultApiKey()).toBeUndefined();
  });
});
