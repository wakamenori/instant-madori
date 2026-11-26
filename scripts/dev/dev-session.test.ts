import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  defaultDevPorts,
  type DevPorts,
  devServers,
  devWorkerPort,
  finishDevelopment,
  holdCheckout,
  portInUse,
  resolveDevSession,
} from "./dev-session.ts";
import { cleanupSteps } from "../shared/processes.ts";
void test("development settles its outcome before cleanup failures", async (t) => {
  const previous = process.exitCode;
  t.after(() => {
    process.exitCode = previous;
  });
  const reports: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    reports.push(args);
  });
  const original = new Error("original spawn failure");
  const disposal = new Error("dispose failure");
  for (const [result, interrupted, expected] of [
    [{ kind: "exit", code: 0, signal: null }, true, 0],
    [{ kind: "exit", code: 17, signal: null }, false, 17],
    [{ kind: "error", error: original }, false, 1],
  ] as const) {
    const observed: (typeof process.exitCode)[] = [];
    await finishDevelopment(result, interrupted, () => {
      observed.push(process.exitCode);
      throw disposal;
    });
    assert.deepEqual(observed, [expected]);
    assert.equal(process.exitCode, expected);
  }
  assert(reports.some((args) => args.includes(original)));
  assert(reports.some((args) => args.includes(disposal)));
});
void test("cleanup attempts each step even after disposal fails", async () => {
  const events: string[] = [];
  const dispose = new Error("dispose");
  const cleanup = new Error("cleanup");
  const problems = await cleanupSteps([
    () => {
      events.push("dispose");
      throw dispose;
    },
    () => {
      events.push("cleanup");
      throw cleanup;
    },
    () => {
      events.push("remove");
    },
  ]);
  assert.deepEqual(events, ["dispose", "cleanup", "remove"]);
  assert.deepEqual(problems, [dispose, cleanup]);
});

void test("default session keeps the usual ports and inspector", async () => {
  const session = await resolveDevSession({}, { inUse: () => Promise.resolve(false) });
  assert.deepEqual(session.ports, { web: 5173, worker: 8787 });
  assert.deepEqual(session.wranglerArgs, ["--ip", "127.0.0.1", "--port", "8787"]);
});

void test("occupied default ports name the role and how to start another session", async () => {
  const roles: readonly (keyof DevPorts)[] = ["web", "worker"];
  for (const role of roles) {
    const busy = defaultDevPorts[role];
    await assert.rejects(
      resolveDevSession({}, { inUse: (port) => Promise.resolve(port === busy) }),
      {
        message: `Port ${busy} (${role}) is in use. Stop the process that uses it, or start with MADORI_DEV_PORTS=auto.`,
      },
    );
  }
});

void test("invalid port modes are rejected", async () => {
  for (const value of ["", "5173,8787", "AUTO"]) {
    await assert.rejects(resolveDevSession({ MADORI_DEV_PORTS: value }), {
      message: `MADORI_DEV_PORTS must be unset or "auto", got "${value}"`,
    });
  }
});

void test("auto skips occupied and duplicate ports and announces the child's actual arguments", async () => {
  const draws = [0.5, 0, 0, 1 - Number.EPSILON];
  const session = await resolveDevSession(
    { MADORI_DEV_PORTS: "auto" },
    {
      random: () => draws.shift() ?? assert.fail("Unexpected extra draw"),
      inUse: (port) => Promise.resolve(port === 26384),
    },
  );
  assert.deepEqual(session.ports, { web: 20000, worker: 32767 });
  const banner = /^Web: http:\/\/127\.0\.0\.1:([0-9]+) \| Worker: http:\/\/127\.0\.0\.1:([0-9]+)$/;
  assert.deepEqual(banner.exec(session.banner)?.slice(1), ["20000", "32767"]);
  assert.deepEqual(session.wranglerArgs, [
    "--ip",
    "127.0.0.1",
    "--port",
    "32767",
    "--inspector-port",
    "0",
  ]);
  assert.deepEqual(session.viteArgs, ["--host", "127.0.0.1", "--port", "20000", "--strictPort"]);
  assert.deepEqual(session.viteEnv, { MADORI_DEV_WORKER_PORT: "32767" });
});

void test("auto limits the number of draws for each port", async () => {
  for (const occupied of [true, false]) {
    let draws = 0;
    await assert.rejects(
      resolveDevSession(
        { MADORI_DEV_PORTS: "auto" },
        {
          inUse: () => Promise.resolve(occupied),
          random() {
            draws++;
            return 0;
          },
        },
      ),
      /20000\.\.32767/,
    );
    assert.equal(draws, occupied ? 100 : 101);
  }
});

void test("worker port accepts only a decimal port in range", () => {
  assert.equal(devWorkerPort({}), 8787);
  for (const value of ["1", "023456", "65535"]) {
    assert.equal(devWorkerPort({ MADORI_DEV_WORKER_PORT: value }), Number(value));
  }
  for (const value of ["", "0", "65536", "20.5", "1e3", "0xff", "+80", " 80", "80\n"]) {
    assert.throws(() => devWorkerPort({ MADORI_DEV_WORKER_PORT: value }), {
      message: `MADORI_DEV_WORKER_PORT must be a port number, got "${value}"`,
    });
  }
});

for (const host of [undefined, "127.0.0.1", "::1"]) {
  void test(`port probe detects a listener on ${host ?? "*"} and its subsequent close`, async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      assert.equal(await portInUse(address.port), true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    assert.equal(await portInUse(address.port), false);
  });
}

void test(
  "a second session in one checkout reports the holder's pid",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "madori-dev-lock-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const lockFile = pathToFileURL(join(directory, ".local", "dev.lock"));
    holdCheckout(lockFile);
    assert.throws(() => holdCheckout(lockFile), {
      message: `pnpm dev is already running in this checkout (pid ${process.pid}). Stop it first.`,
    });
  },
);

void test("dev passes the Docker tether to Wrangler and the worker port to Vite", async () => {
  const session = await resolveDevSession({}, { inUse: () => Promise.resolve(false) });
  const [wrangler, vite] = devServers(session, {});
  assert.equal(
    wrangler.options.env["WRANGLER_DOCKER_BIN"],
    fileURLToPath(new URL("../shared/docker-tether.sh", import.meta.url)),
  );
  assert.equal(wrangler.options.env["MADORI_DOCKER_TETHER_TARGET"], "docker");
  assert.equal(vite.options.env["MADORI_DEV_WORKER_PORT"], "8787");
});
