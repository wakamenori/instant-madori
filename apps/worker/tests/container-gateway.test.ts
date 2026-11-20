import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogFields } from "../src/log.ts";
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
  let lastActivityAt: unknown;
  let alarm: number | null = null;
  let alarmDeletes = 0;
  const inactivityTimeouts: number[] = [];
  let starts = 0;
  let destroys = 0;
  let timeouts = 0;
  const requests: Request[] = [];
  let healthy = true;
  let protocol = true;
  let status = 200;
  let failStart = false;
  let failDestroy = false;
  let failFetch = false;
  const container: ContainerHandle & { running: boolean } = {
    running: false,
    images: { geometry: "image-1" },
    start() {
      starts++;
      if (failStart) throw new Error("start");
      container.running = true;
    },
    async destroy() {
      await Promise.resolve();
      destroys++;
      if (failDestroy) throw new Error("destroy");
      container.running = false;
    },
    async setInactivityTimeout(ms) {
      inactivityTimeouts.push(ms);
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
  let stopRetryMs: number | undefined;
  const store = {
    readStopRetry: () => stopRetryMs,
    writeStopRetry: (ms: number) => {
      stopRetryMs = ms;
    },
    clearStopRetry: () => {
      stopRetryMs = undefined;
    },
    readActivity: () => lastActivityAt,
    writeActivity: (at: number) => {
      lastActivityAt = at;
    },
    clearActivity: () => {
      lastActivityAt = undefined;
    },
    setAlarm: (at: number) => {
      alarm = at;
      return Promise.resolve();
    },
    deleteAlarm: () => {
      alarm = null;
      alarmDeletes++;
      return Promise.resolve();
    },
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
    fields: LogFields;
    level: "info" | "error" | undefined;
  }[] = [];
  const deadlines = new Map<AbortController, number>();
  const environment: GatewayEnvironment = {
    now: () => clock,
    deadline: (ms: number) => {
      const controller = new AbortController();
      deadlines.set(controller, ms);
      return {
        signal: controller.signal,
        clear: () => {
          deadlines.delete(controller);
        },
      };
    },
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
    timeoutMs: 500,
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
    openDeadlines: () => [...deadlines.values()],
    fireDeadlines: () => {
      for (const controller of deadlines.keys()) {
        controller.abort();
        deadlines.delete(controller);
      }
    },
    inactivityTimeouts,
    alarm: () => alarm,
    alarmDeletes: () => alarmDeletes,
    at: (at: number) => {
      clock = at;
    },
    recover: () => {
      healthy = true;
      status = 200;
      failFetch = false;
      failDestroy = false;
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
    },
  };
}
void test("concurrent cold requests share startup; warm sends carry only the owned token", async () => {
  const f = fixture();
  const gateway = f.make();
  const results = await Promise.all([
    gateway.run((send) => send(f.call)),
    gateway.run((send) => send(f.call)),
  ]);
  assert.deepEqual(f.openDeadlines(), []);
  assert(results.every((r) => r.kind === "response" && r.start === "cold"));
  assert.equal(f.counts().starts, 1);
  const warm = await gateway.run((send) => send(f.call));
  assert.deepEqual(f.openDeadlines(), []);
  assert.deepEqual(f.inactivityTimeouts, [120_000, 120_000, 120_000, 120_000]);
  assert.equal(warm.kind === "response" && warm.start, "warm");
  assert.equal(f.requests.at(-1)?.headers.get("authorization"), "Bearer token-0");
  assert.equal(f.requests.at(-1)?.headers.get("x-trace"), "trace-1");
});
void test("DO restart adopts the stored token and rearms idle timeout; image skew replaces", async () => {
  const f = fixture();
  await f.make().run((send) => send(f.call));
  const adopted = f.make();
  await adopted.resume();
  const result = await adopted.run((send) => send(f.call));
  assert.equal(result.kind === "response" && result.start, "warm");
  assert.deepEqual(f.openDeadlines(), []);
  assert.equal(f.counts().starts, 1);
  assert.equal(f.counts().timeouts, 5);
  f.store.write({ token: "old", image: "old-image", startedAt: 0 });
  await f.make().run((send) => send(f.call));
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
    const result = await f.make().run((send) => send(f.call));
    assert.deepEqual(f.openDeadlines(), []);
    assert.deepEqual(result, { kind: "unavailable", reason });
    assert.equal(f.store.read(), undefined);
    assert.equal(f.container.running, false);
  }
});
void test("missing record replaces an orphan; exit restarts; connection failure reprobes", async () => {
  const f = fixture();
  f.container.running = true;
  const gateway = f.make();
  await gateway.run((send) => send(f.call));
  assert.equal(f.counts().destroys, 1);
  f.exit();
  const next = await gateway.run((send) => send(f.call));
  assert.equal(next.kind === "response" && next.start, "cold");
  assert.equal(f.requests.at(-1)?.headers.get("authorization"), "Bearer token-1");
  assert.equal(f.counts().destroys, 1);
  assert.equal(f.counts().starts, 2);
  f.failFetch();
  assert.deepEqual(await gateway.run((send) => send(f.call)), {
    kind: "unavailable",
    reason: "unreachable",
  });
  assert.deepEqual(f.openDeadlines(), []);
  assert.deepEqual(
    await new ContainerGateway(undefined, f.store, f.settings, f.environment).run((send) =>
      send(f.call),
    ),
    { kind: "unavailable", reason: "containers_disabled" },
  );
});

for (const answer of ["throw", "healthy"] as const) {
  void test(`exit during readiness clears the lifetime when the probe answers ${answer}`, async () => {
    const f = fixture();
    const gateway = f.make();
    const fetchPort = f.container.fetchPort.bind(f.container);
    f.container.fetchPort = async (request) => {
      const response = await fetchPort(request);
      f.container.running = false;
      if (answer === "throw") throw new Error("exited");
      return response;
    };
    assert.deepEqual(await gateway.run((send) => send(f.call)), {
      kind: "unavailable",
      reason: "exited",
    });
    assert.equal(f.store.read(), undefined);
    assert.equal(
      f.events.some((entry) => entry.event === "container.ready"),
      false,
    );
    f.container.fetchPort = fetchPort;
    const next = await gateway.run((send) => send(f.call));
    assert.equal(next.kind === "response" && next.start, "cold");
    assert.equal(f.requests.at(-1)?.headers.get("authorization"), "Bearer token-1");
  });
}

void test("failed readiness and token rejection restart; failed transport reprobes without replay", async () => {
  for (const cause of ["unhealthy", "reject"] as const) {
    const f = fixture();
    const gateway = f.make();
    f[cause]();
    assert.equal((await gateway.run((send) => send(f.call))).kind, "unavailable");
    f.recover();
    assert.equal((await gateway.run((send) => send(f.call))).kind, "response");
    assert.equal(f.counts().starts, 2);
  }
  const f = fixture();
  const gateway = f.make();
  await gateway.run((send) => send(f.call));
  f.failFetch();
  assert.equal((await gateway.run((send) => send(f.call))).kind, "unavailable");
  const probes = f.requests.filter((r) => new URL(r.url).pathname === "/healthz").length;
  f.recover();
  const reprobe = await gateway.run((send) => send(f.call));
  assert.equal(reprobe.kind === "response" && reprobe.start, "warm");
  assert.equal(f.counts().starts, 1);
  assert.equal(f.requests.filter((r) => new URL(r.url).pathname === "/healthz").length, probes + 1);
});
void test("concurrent callers share a failed start and its cleanup", async () => {
  const f = fixture();
  f.failStart();
  const gateway = f.make();
  const results = await Promise.all([
    gateway.run((send) => send(f.call)),
    gateway.run((send) => send(f.call)),
  ]);
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
  await gateway.run((send) => send(f.call));
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
  const rejected = gateway.run((send) => send(f.call));
  await destroying;
  f.recover();
  const replacement = gateway.run((send) => send(f.call));
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
  await f.make().run((send) => send(f.call));
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
      ...f.store,
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
  assert.equal((await gateway.run((send) => send(f.call))).kind, "response");
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
  assert.equal((await gateway.run((send) => send(f.call))).kind, "response");
});

void test("destroy failures are errors and ready logs distinguish lifecycle modes", async () => {
  const f = fixture();
  const gateway = f.make();
  await gateway.run((send) => send(f.call));
  assert.equal(
    f.events.filter((e) => e.event === "container.ready").at(-1)?.fields["mode"],
    "cold",
  );
  await f.make().run((send) => send(f.call));
  assert.equal(
    f.events.filter((e) => e.event === "container.ready").at(-1)?.fields["mode"],
    "adopted",
  );
  f.failFetch();
  await gateway.run((send) => send(f.call));
  f.recover();
  await gateway.run((send) => send(f.call));
  assert.equal(
    f.events.filter((e) => e.event === "container.ready").at(-1)?.fields["mode"],
    "reprobe",
  );
  f.failDestroy();
  f.reject();
  await gateway.run((send) => send(f.call));
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
      .run((send) =>
        send({ ...f.call, method: "POST", body, contentType: "application/octet-stream" }),
      );
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
    assert.deepEqual(await f.make().run((send) => send(f.call)), { kind: "unavailable", reason });
    assert.equal(f.counts().destroys, 1);
  }
});

void test("operations move the idle deadline; early alarms rearm and expiry stops once", async () => {
  const f = fixture();
  const gateway = f.make();
  await gateway.run((send) => send(f.call));
  assert.equal(f.alarm(), 60_000);
  f.at(40_000);
  await gateway.run((send) => send(f.call));
  assert.equal(f.store.readActivity(), 40_000);
  assert.equal(f.alarm(), 100_000);
  f.at(60_000);
  await f.store.deleteAlarm();
  await gateway.alarm();
  assert.equal(f.container.running, true);
  assert.equal(f.alarm(), 100_000);
  f.at(100_000);
  await gateway.alarm();
  assert.equal(f.container.running, false);
  assert.equal(f.store.read(), undefined);
  assert.equal(f.store.readActivity(), undefined);
  assert.equal(f.alarm(), null);
  assert.deepEqual(
    f.events.filter((e) => e.event === "container.idle_stopped"),
    [{ event: "container.idle_stopped", fields: { ms: 60_000 }, level: undefined }],
  );
  await gateway.alarm();
  assert.equal(f.counts().destroys, 1);
  assert.equal(f.events.filter((e) => e.event === "container.idle_stopped").length, 1);
  const next = await gateway.run((send) => send(f.call));
  assert.equal(next.kind === "response" && next.start, "cold");
  assert.equal(f.counts().starts, 2);
});

void test("resume preserves the stored deadline and the waking alarm; fallback has 60 seconds margin", async () => {
  const f = fixture();
  await f.make().run((send) => send(f.call));
  f.at(60_000);
  const deletes = f.alarmDeletes();
  const resumed = f.make();
  await resumed.resume();
  assert.equal(f.alarmDeletes(), deletes);
  assert.equal(f.alarm(), 60_000);
  assert.equal(f.store.readActivity(), 0);
  assert.deepEqual(f.inactivityTimeouts, [120_000, 120_000, 120_000]);
  await resumed.alarm();
  assert.equal(f.counts().destroys, 1);
});

void test("resume bounds missing, malformed and future activity by the current time", async () => {
  for (const value of [undefined, "wrong", NaN, Infinity, -1, 1_000_000]) {
    const f = fixture();
    await f.make().run((send) => send(f.call));
    const readActivity = f.store.readActivity;
    f.store.readActivity = () => value;
    f.at(5_000);
    await f.make().resume();
    assert.equal(f.alarm(), 65_000);
    f.store.readActivity = readActivity;
    assert.equal(f.store.readActivity(), 5_000);
  }
  const f = fixture();
  await f.make().run((send) => send(f.call));
  f.at(1_000);
  f.store.writeActivity(5_000_000);
  await f.make().resume();
  assert.equal(f.store.readActivity(), 1_000);
  assert.equal(f.alarm(), 61_000);
});

void test("resume cleans stopped containers without starting them", async () => {
  const f = fixture();
  await f.make().run((send) => send(f.call));
  f.exit();
  const resumed = f.make();
  await resumed.resume();
  await resumed.alarm();
  assert.equal(f.store.read(), undefined);
  assert.equal(f.store.readActivity(), undefined);
  assert.equal(f.alarm(), null);
  assert.equal(f.counts().starts, 1);
  assert.equal(f.counts().destroys, 0);
});

void test("a pending response body is protected; the idle window starts after consumption", async () => {
  const f = fixture();
  const gateway = f.make();
  const fetchPort = f.container.fetchPort.bind(f.container);
  let signal: AbortSignal | undefined;
  let finishBody: () => void = () => undefined;
  let reading: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    reading = resolve;
  });
  f.container.fetchPort = (request) => {
    if (new URL(request.url).pathname === "/healthz") return fetchPort(request);
    signal = request.signal;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            finishBody = () => {
              controller.enqueue(new TextEncoder().encode("body"));
              controller.close();
            };
          },
        }),
      ),
    );
  };
  const operation = gateway.run(async (send) => {
    const result = await send(f.call);
    assert.equal(result.kind, "response");
    assert(result.kind === "response");
    reading();
    assert.equal(await result.response.text(), "body");
  });
  await entered;
  assert.deepEqual(f.openDeadlines(), [f.call.timeoutMs]);
  assert(signal);
  assert.equal(signal.aborted, false);
  f.fireDeadlines();
  assert.equal(signal.aborted, true);
  f.at(90_000);
  await gateway.alarm();
  assert.equal(f.counts().destroys, 0);
  assert.equal(f.alarm(), 150_000);
  f.at(100_000);
  finishBody();
  await operation;
  assert.equal(f.store.readActivity(), 100_000);
  assert.equal(f.alarm(), 160_000);
  f.at(160_000);
  await gateway.alarm();
  assert.equal(f.counts().destroys, 1);
});

void test("overlapping operations record their actual completion order, including errors", async () => {
  const f = fixture();
  const gateway = f.make();
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = gateway.run(async (send) => {
    await send(f.call);
    entered();
    await blocked;
    throw new Error("body failed");
  });
  await started;
  f.at(30_000);
  await gateway.run((send) => send(f.call));
  f.at(90_000);
  await gateway.alarm();
  assert.equal(f.counts().destroys, 0);
  f.at(100_000);
  release();
  await assert.rejects(first, /body failed/);
  assert.deepEqual(f.openDeadlines(), []);
  assert.equal(f.store.readActivity(), 100_000);
  assert.equal(f.alarm(), 160_000);
});

void test("repeated destroy failures preserve both records and keep bounded retry alarms", async () => {
  const f = fixture();
  const gateway = f.make();
  await gateway.run((send) => send(f.call));
  const record = f.store.read();
  f.failDestroy();
  let now = 60_000;
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]) {
    f.at(now);
    await gateway.alarm();
    assert.deepEqual(f.store.read(), record);
    assert.equal(f.store.readActivity(), 0);
    assert.equal(f.container.running, true);
    assert.equal(f.alarm(), now + delay);
    now += delay;
  }
  assert.equal(f.events.filter((e) => e.event === "container.destroy_failed").length, 9);
  assert.equal(f.events.filter((e) => e.event === "container.idle_stopped").length, 0);
  f.recover();
  f.at(now);
  await gateway.alarm();
  assert.equal(f.container.running, false);
  assert.equal(f.store.read(), undefined);
  assert.equal(f.alarm(), null);
});

void test("a request arriving during idle destruction starts after all old cleanup", async () => {
  const f = fixture();
  const gateway = f.make();
  await gateway.run((send) => send(f.call));
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const destroying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const destroy = f.container.destroy.bind(f.container);
  f.container.destroy = async (reason) => {
    entered();
    await gate;
    await destroy(reason);
  };
  f.at(60_000);
  const stopping = gateway.alarm();
  await destroying;
  const next = gateway.run((send) => send(f.call));
  assert.equal(f.counts().starts, 1);
  release();
  await stopping;
  const result = await next;
  assert.equal(result.kind === "response" && result.start, "cold");
  assert.equal(f.counts().starts, 2);
  assert.equal(f.store.read()?.token, "token-1");
  assert.equal(f.store.readActivity(), 60_000);
  assert.equal(f.alarm(), 120_000);
  await f.make().resume();
  await f.make().run((send) => send(f.call));
  assert.equal(f.counts().starts, 2);
});

void test("the alarm forgets an exited Container without destroying it", async () => {
  const f = fixture();
  const gateway = f.make();
  await gateway.run((send) => send(f.call));
  f.exit();
  await gateway.alarm();
  assert.equal(f.store.read(), undefined);
  assert.equal(f.store.readActivity(), undefined);
  assert.equal(f.alarm(), null);
  assert.equal(f.counts().destroys, 0);
});

void test("an inactivity timeout failure preserves the response and idle alarm", async () => {
  const f = fixture();
  const gateway = f.make();
  await gateway.run((send) => send(f.call));
  f.container.setInactivityTimeout = () => Promise.reject(new Error("rearm failed"));
  const result = await gateway.run(async (send) => {
    const response = await send(f.call);
    f.at(10_000);
    return response;
  });
  assert.equal(result.kind === "response" && result.start, "warm");
  assert.equal(f.alarm(), 70_000);
  assert.deepEqual(
    f.events.filter((e) => e.event === "container.inactivity_failed").map((e) => e.level),
    ["error"],
  );
});

void test("retry alarms double across DO restarts until an operation or successful stop", async () => {
  const f = fixture();
  await f.make().run((send) => send(f.call));
  f.failDestroy();
  let now = 60_000;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    f.at(now);
    const restarted = f.make();
    await restarted.resume();
    await restarted.alarm();
    now += delay;
    assert.equal(f.alarm(), now);
  }
  await f.make().run((send) => send(f.call));
  assert.equal(f.store.readStopRetry(), undefined);
  f.at(now + 60_000);
  await f.make().alarm();
  assert.equal(f.store.readStopRetry(), 2000);
  f.recover();
  await f.make().alarm();
  assert.equal(f.store.readStopRetry(), undefined);
});

void test("a response body the operation leaves unread is aborted when the operation settles", async () => {
  const f = fixture();
  const gateway = f.make();
  const fetchPort = f.container.fetchPort.bind(f.container);
  let signal: AbortSignal | undefined;
  f.container.fetchPort = (request) => {
    if (new URL(request.url).pathname === "/healthz") return fetchPort(request);
    signal = request.signal;
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>()));
  };
  const result = await gateway.run((send) => send(f.call));
  assert.equal(result.kind, "response");
  assert(signal);
  assert.equal(signal.aborted, true, "the unread body's request is aborted");
  assert.deepEqual(f.openDeadlines(), []);
});

void test("a send the operation does not await cannot start a request after it settles", async () => {
  const f = fixture();
  const gateway = f.make();
  let kept: ((request: typeof f.call) => Promise<unknown>) | undefined;
  let inFlight: Promise<unknown> | undefined;
  await gateway.run((send) => {
    kept = send;
    inFlight = send(f.call);
    return Promise.resolve();
  });
  assert(kept && inFlight);
  await assert.rejects(inFlight, /send after the operation settled/);
  await assert.rejects(kept(f.call), /send after the operation settled/);
  assert.equal(
    f.requests.filter((r) => new URL(r.url).pathname === f.call.path).length,
    0,
    "no operation request reached the Container",
  );
  assert.deepEqual(f.openDeadlines(), []);
});
