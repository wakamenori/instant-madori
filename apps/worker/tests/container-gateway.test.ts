import assert from "node:assert/strict";
import { test } from "node:test";
import { ContainerGateway } from "../src/geometry/container-gateway.ts";
import type {
  ContainerHandle,
  GatewayEnvironment,
  GatewaySettings,
  StartRecord,
} from "../src/geometry/container-gateway.ts";
function fixture() {
  let record: StartRecord | undefined;
  let clock = 0;
  let starts = 0;
  let destroys = 0;
  let timeouts = 0;
  let stop: () => void = () => undefined;
  const requests: Request[] = [];
  let healthy = true;
  let protocol = true;
  let status = 200;
  let failStart = false;
  let failDestroy = false;
  let failFetch = false;
  let failMonitor = false;
  let delayExit = false;
  const monitors: (() => void)[] = [];
  const container: ContainerHandle & { running: boolean } = {
    running: false,
    images: { geometry: "image-1" },
    start() {
      starts++;
      if (failStart) throw new Error("start");
      container.running = true;
    },
    monitor: () =>
      failMonitor
        ? Promise.reject(new Error("exit during startup"))
        : new Promise((resolve) => {
            stop = resolve;
            monitors.push(resolve);
          }),
    async destroy() {
      await Promise.resolve();
      destroys++;
      if (failDestroy) throw new Error("destroy");
      container.running = false;
      if (!delayExit) stop();
    },
    async setInactivityTimeout() {
      await Promise.resolve();
      timeouts++;
    },
    async fetchPort(request) {
      await Promise.resolve();
      requests.push(request);
      if (new URL(request.url).pathname === "/healthz")
        return Response.json({ valid: protocol }, { status: healthy ? 200 : 503 });
      if (failFetch) throw new Error("connection");
      return new Response("display", { status });
    },
  };
  const store = {
    read: () => record,
    write: (value: StartRecord) => {
      record = value;
    },
    clear: () => {
      record = undefined;
    },
  };
  const settings: GatewaySettings = {
    imageName: "geometry",
    instance: "standard-1",
    idleTimeoutMs: 60000,
    tokenEnv: "TOKEN",
    authorizationHeader: "authorization",
    traceHeader: "x-trace",
    readiness: {
      path: "/healthz",
      acceptHealth: async (response) => {
        const body: unknown = await response.json();
        return typeof body === "object" && body !== null && "valid" in body && body.valid === true;
      },
      deadlineMs: 10,
      intervalMs: 2,
      probeTimeoutMs: 100,
    },
  };
  const events: {
    event: string;
    fields: Record<string, string | number>;
    level: "info" | "error" | undefined;
  }[] = [];
  const environment: GatewayEnvironment = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
      await Promise.resolve();
    },
    newToken: () => `token-${starts}`,
    log: (event, fields, level) => {
      events.push({ event, fields, level });
    },
  };
  const make = () => new ContainerGateway(container, store, settings, environment);
  const call = {
    method: "GET",
    path: "/v1/sample/display",
    traceId: "trace-1",
    timeoutMs: 100,
  } as const;
  return {
    container,
    store,
    settings,
    environment,
    make,
    call,
    requests,
    events,
    monitors,
    delayExit: () => {
      delayExit = true;
    },
    recover: () => {
      healthy = true;
      status = 200;
      failFetch = false;
    },
    failMonitor: () => {
      failMonitor = true;
    },
    counts: () => ({ starts, destroys, timeouts }),
    unhealthy: () => {
      healthy = false;
    },
    mismatch: () => {
      protocol = false;
    },
    reject: () => {
      status = 401;
    },
    failDestroy: () => {
      failDestroy = true;
    },
    failStart: () => {
      failStart = true;
    },
    failFetch: () => {
      failFetch = true;
    },
    exit: () => {
      container.running = false;
      stop();
    },
  };
}
void test("concurrent cold requests share startup; warm sends carry only the owned token", async () => {
  const f = fixture();
  const gateway = f.make();
  const results = await Promise.all([gateway.send(f.call), gateway.send(f.call)]);
  assert(results.every((r) => r.kind === "response" && r.start === "cold"));
  assert.equal(f.counts().starts, 1);
  const warm = await gateway.send(f.call);
  assert.equal(warm.kind === "response" && warm.start, "warm");
  assert.equal(f.requests.at(-1)?.headers.get("authorization"), "Bearer token-0");
  assert.equal(f.requests.at(-1)?.headers.get("x-trace"), "trace-1");
});
void test("DO restart adopts the stored token and rearms idle timeout; image skew replaces", async () => {
  const f = fixture();
  await f.make().send(f.call);
  const adopted = f.make();
  await adopted.resume();
  await adopted.send(f.call);
  assert.equal(f.counts().starts, 1);
  assert.equal(f.counts().timeouts, 3);
  f.store.write({ token: "old", image: "old-image", startedAt: 0 });
  await f.make().send(f.call);
  assert.equal(f.counts().starts, 2);
  assert.equal(f.counts().destroys, 1);
  assert.equal(f.store.read()?.token, "token-1");
});
void test("unavailability clears failed starts and destroys unready or unauthorized containers", async () => {
  for (const [cause, reason] of [
    ["unhealthy", "not_ready"],
    ["mismatch", "protocol_mismatch"],
    ["failStart", "start_failed"],
    ["reject", "token_rejected"],
  ] as const) {
    const f = fixture();
    f[cause]();
    const result = await f.make().send(f.call);
    assert.deepEqual(result, { kind: "unavailable", reason });
    assert.equal(f.store.read(), undefined);
    assert.equal(f.container.running, false);
  }
});
void test("missing record replaces an orphan; exit restarts; connection failure reprobes", async () => {
  const f = fixture();
  f.container.running = true;
  const gateway = f.make();
  await gateway.send(f.call);
  assert.equal(f.counts().destroys, 1);
  f.exit();
  await Promise.resolve();
  await gateway.send(f.call);
  assert.equal(f.counts().starts, 2);
  f.failFetch();
  assert.deepEqual(await gateway.send(f.call), { kind: "unavailable", reason: "unreachable" });
  assert.deepEqual(
    await new ContainerGateway(undefined, f.store, f.settings, f.environment).send(f.call),
    { kind: "unavailable", reason: "containers_disabled" },
  );
});

void test("a rejected monitor during startup aborts readiness and clears its record", async () => {
  const f = fixture();
  f.failMonitor();
  assert.deepEqual(await f.make().send(f.call), { kind: "unavailable", reason: "exited" });
  assert.equal(f.store.read(), undefined);
  assert.equal(f.counts().destroys, 1);
});

void test("failed readiness and token rejection restart; failed transport reprobes without replay", async () => {
  for (const cause of ["unhealthy", "reject"] as const) {
    const f = fixture();
    const gateway = f.make();
    f[cause]();
    assert.equal((await gateway.send(f.call)).kind, "unavailable");
    f.recover();
    assert.equal((await gateway.send(f.call)).kind, "response");
    assert.equal(f.counts().starts, 2);
  }
  const f = fixture();
  const gateway = f.make();
  await gateway.send(f.call);
  f.failFetch();
  assert.equal((await gateway.send(f.call)).kind, "unavailable");
  const probes = f.requests.filter((r) => new URL(r.url).pathname === "/healthz").length;
  f.recover();
  assert.equal((await gateway.send(f.call)).kind, "response");
  assert.equal(f.counts().starts, 1);
  assert.equal(f.requests.filter((r) => new URL(r.url).pathname === "/healthz").length, probes + 1);
});
void test("a delayed old monitor cannot erase a newer ready lifetime", async () => {
  const f = fixture();
  const gateway = f.make();
  f.delayExit();
  await gateway.send(f.call);
  const old = f.monitors[0];
  assert(old);
  f.reject();
  await gateway.send(f.call);
  f.recover();
  await gateway.send(f.call);
  old();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.store.read()?.token, "token-1");
  const warm = await gateway.send(f.call);
  assert.equal(warm.kind === "response" && warm.start, "warm");
  assert.equal(f.counts().starts, 2);
});

void test("concurrent callers share a failed start and its cleanup", async () => {
  const f = fixture();
  f.failStart();
  const gateway = f.make();
  const results = await Promise.all([gateway.send(f.call), gateway.send(f.call)]);
  assert.deepEqual(results, [
    { kind: "unavailable", reason: "start_failed" },
    { kind: "unavailable", reason: "start_failed" },
  ]);
  assert.equal(f.counts().starts, 1);
  assert.equal(f.counts().destroys, 1);
  assert.equal(f.store.read(), undefined);
});

void test("a request waiting for reset is measured as a cold replacement", async () => {
  const f = fixture();
  const gateway = f.make();
  await gateway.send(f.call);
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const destroying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = f.container.destroy.bind(f.container);
  f.container.destroy = async (reason) => {
    entered();
    await gate;
    await original(reason);
  };
  f.reject();
  const rejected = gateway.send(f.call);
  await destroying;
  f.recover();
  const replacement = gateway.send(f.call);
  release();
  await rejected;
  const response = await replacement;
  assert.equal(response.kind === "response" && response.start, "cold");
});

void test("readiness timing includes the start call and setup", async () => {
  const f = fixture();
  const now = f.environment.now.bind(f.environment);
  const start = f.container.start.bind(f.container);
  let startupMs = 0;
  f.environment.now = () => now() + startupMs;
  f.container.start = (options) => {
    startupMs += 3;
    start(options);
  };
  await f.make().send(f.call);
  assert.equal(f.events.find((entry) => entry.event === "container.ready")?.fields["ms"], 3);
});

void test("malformed persisted records are cleared and running containers replaced", async () => {
  const f = fixture();
  f.container.running = true;
  let stored: unknown = { token: 12 };
  let clears = 0;
  const gateway = new ContainerGateway(
    f.container,
    {
      read: () => stored,
      write: (value) => {
        stored = value;
      },
      clear: () => {
        clears++;
        stored = undefined;
      },
    },
    f.settings,
    f.environment,
  );
  assert.equal((await gateway.send(f.call)).kind, "response");
  assert.equal(clears, 1);
  assert.equal(f.counts().destroys, 1);
  assert(
    f.events.some(
      (e) =>
        e.event === "container.invalid_record" &&
        e.level === "error" &&
        e.fields["traceId"] === "trace-1",
    ),
  );
  assert.equal((await gateway.send(f.call)).kind, "response");
});

void test("destroy failures are errors and ready logs distinguish lifecycle modes", async () => {
  const f = fixture();
  const gateway = f.make();
  await gateway.send(f.call);
  assert.equal(
    f.events.filter((e) => e.event === "container.ready").at(-1)?.fields["mode"],
    "cold",
  );
  await f.make().send(f.call);
  assert.equal(
    f.events.filter((e) => e.event === "container.ready").at(-1)?.fields["mode"],
    "adopted",
  );
  f.failFetch();
  await gateway.send(f.call);
  f.recover();
  await gateway.send(f.call);
  assert.equal(
    f.events.filter((e) => e.event === "container.ready").at(-1)?.fields["mode"],
    "reprobe",
  );
  f.failDestroy();
  f.reject();
  await gateway.send(f.call);
  const failure = f.events.find((e) => e.event === "container.destroy_failed");
  assert.equal(failure?.level, "error");
  assert.equal(failure?.fields["traceId"], f.call.traceId);
});

void test("binary operation bodies reach the container unchanged", async () => {
  for (const body of [
    new Uint8Array([0, 255, 128, 4]),
    new Uint8Array([0, 255, 128, 4]).buffer,
    "binary",
  ]) {
    const f = fixture();
    await f
      .make()
      .send({ ...f.call, method: "POST", body, contentType: "application/octet-stream" });
    const request = f.requests.at(-1);
    assert(request);
    assert.equal(request.headers.get("content-type"), "application/octet-stream");
    const expected =
      typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
    assert.deepEqual(new Uint8Array(await request.arrayBuffer()), expected);
  }
});

void test("contract readiness distinguishes protocol rejection from the retry deadline", async () => {
  const { acceptReadinessResponse } = await import("../src/geometry/geometry-protocol.ts");
  const valid = { status: "ok", service: "geometry", protocol: 1 };
  for (const [makeResponse, reason] of [
    [() => new Response(JSON.stringify(valid)), "protocol_mismatch"],
    [() => Response.json({ ...valid, padding: "x".repeat(4096) }), "protocol_mismatch"],
    [() => Response.json({ ...valid, protocol: 2 }), "protocol_mismatch"],
    [() => new Response(null, { status: 503 }), "not_ready"],
  ] as const) {
    const f = fixture();
    f.settings.readiness.acceptHealth = acceptReadinessResponse;
    f.container.fetchPort = () => Promise.resolve(makeResponse());
    assert.deepEqual(await f.make().send(f.call), { kind: "unavailable", reason });
    assert.equal(f.counts().destroys, 1);
  }
});
