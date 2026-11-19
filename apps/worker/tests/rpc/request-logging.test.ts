import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { handleApi } from "../../src/api/app.ts";
import { systemRuntime } from "../../src/runtime.ts";

void test("API request logs classify server failures and successful/client responses", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  t.mock.method(console, "error", (line: string) => lines.push(line));
  const env: Env = {
    ENVIRONMENT: "invalid",
    JOB_TEST_HOLD: "none",
    APP_ORIGINS: "",
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    ACCESS_JWKS: "",
    GEOMETRY_INSTANCE_TYPE: "standard-1",
    GEOMETRY_IDLE_TIMEOUT_MS: "600000",
    get BLOBS(): never {
      throw new Error("Bucket must not be accessed");
    },
    get DB(): never {
      throw new Error("not reached");
    },
    get ASSETS(): never {
      throw new Error("not reached");
    },
    get PATTERNS(): never {
      throw new Error("PATTERNS not used");
    },
    get GEOMETRY(): never {
      throw new Error("not reached");
    },
  };
  for (const [path, status, level] of [
    ["/api/me", 500, "error"],
    ["/api/health", 200, "info"],
    ["/api/missing", 404, "info"],
  ] as const) {
    const url = new URL(path, "http://worker");
    const response = await handleApi(new Request(url), url, env, systemRuntime);
    assert.equal(response.status, status);
    const entry = lines
      .map((line) =>
        z
          .object({ event: z.string(), level: z.string(), status: z.number().optional() })
          .parse(JSON.parse(line)),
      )
      .filter((entry) => entry.event === "api.request")
      .at(-1);
    assert.equal(entry?.status, status);
    assert.equal(entry?.level, level);
  }
});
