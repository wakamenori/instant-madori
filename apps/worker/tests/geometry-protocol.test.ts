import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatewayRequest } from "../src/geometry/container-gateway.ts";
import { geometryInternal, geometryBodySchemas } from "@madori/contracts/geometry-internal";
import {
  acceptGeometryHealth,
  readSampleDisplay,
  callGeometry,
  acceptBytes,
  createGeometryCaller,
  acceptReadinessResponse,
} from "../src/geometry/geometry-protocol.ts";
const call = { traceId: "trace-1" };
const binaryCall = (send: Parameters<typeof readSampleDisplay>[0], call: { traceId: string }) =>
  callGeometry(send, "sampleDisplay", {
    ...call,
  });
void test(
  "protocol validates health, errors, type and bounded streamed bytes",
  { timeout: 2000 },
  async () => {
    assert(acceptGeometryHealth({ status: "ok", service: "geometry", protocol: 1 }));
    assert(!acceptGeometryHealth({ status: "ok", service: "geometry", protocol: 2 }));
    const send = (response: Response) =>
      binaryCall(
        () => Promise.resolve({ kind: "response", response, start: "cold", ms: 12 }),
        call,
      );
    const ok = await send(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": geometryInternal.displayContentType },
      }),
    );
    assert.equal(ok.kind, "ok");
    if (ok.kind === "ok")
      assert.deepEqual(new Uint8Array(ok.value.bytes), new Uint8Array([1, 2, 3]));
    assert.deepEqual(await send(new Response("wrong")), {
      kind: "failed",
      reason: "protocol_violation",
      status: 200,
      violation: "content_type",
    });
    for (const code of ["build_failed", "unknown"]) {
      const failed = await send(Response.json({ error: code }, { status: 500 }));
      assert.equal(
        failed.kind === "failed" && failed.reason,
        code === "unknown" ? "protocol_violation" : code,
      );
      assert.equal("status" in failed && failed.status, 500);
    }
    let cancelled = false;
    const large = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(geometryInternal.maxDisplayBytes + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    assert.deepEqual(
      await send(
        new Response(large, { headers: { "content-type": geometryInternal.displayContentType } }),
      ),
      { kind: "failed", reason: "protocol_violation", status: 200, violation: "too_large" },
    );
    assert(cancelled);
    assert.deepEqual(
      await binaryCall(
        () => Promise.resolve({ kind: "unavailable", reason: "containers_disabled" }),
        call,
      ),
      { kind: "unavailable", reason: "containers_disabled" },
    );
  },
);

void test("interrupted success and error bodies are unavailable", async () => {
  for (const status of [200, 500]) {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
      },
      pull(c) {
        c.error(new Error("container crashed"));
      },
    });
    const result = await binaryCall(
      () =>
        Promise.resolve({
          kind: "response",
          response: new Response(stream, {
            status,
            headers: {
              "content-type":
                status === 200 ? geometryInternal.displayContentType : "application/json",
            },
          }),
          start: "warm",
          ms: 1,
        }),
      call,
    );
    assert.deepEqual(result, { kind: "unavailable", reason: "unreachable" });
  }
});

void test("generic JSON routes validate bodies, status, type, and bounded streams", async () => {
  const invoke = (response: Response) =>
    callGeometry(
      () => Promise.resolve({ kind: "response", response, start: "warm", ms: 2 }),
      "health",
      call,
    );
  for (const status of [200, 201, 299]) {
    const result = await invoke(
      Response.json({ status: "ok", service: "geometry", protocol: 1 }, { status }),
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") assert.equal(result.value.protocol, 1);
  }
  for (const [response, violation] of [
    [Response.json({ status: "wrong" }), "schema"],
    [new Response("{", { headers: { "content-type": "application/json" } }), "invalid_json"],
    [new Response("{}"), "content_type"],
    [
      new Response("x".repeat(4097), { headers: { "content-type": "application/json" } }),
      "too_large",
    ],
    [new Response("bad", { status: 302 }), "status"],
    [Response.json({ error: "nope" }, { status: 500 }), "schema"],
  ] as const)
    assert.deepEqual(await invoke(response), {
      kind: "failed",
      reason: "protocol_violation",
      status: response.status,
      violation,
    });
});

void test(
  "sample declaration selects its contract route and binary accept policy",
  { timeout: 2000 },
  async () => {
    const result = await readSampleDisplay((request) => {
      assert.equal(request.path, geometryInternal.routes.sampleDisplay.path);
      assert.equal(request.method, geometryInternal.routes.sampleDisplay.method);
      assert.equal(request.timeoutMs, 30_000);
      assert.equal(request.traceId, call.traceId);
      return Promise.resolve({
        kind: "response",
        response: new Response(new Uint8Array([7]), {
          headers: { "content-type": geometryInternal.displayContentType },
        }),
        start: "cold",
        ms: 1,
      });
    }, call);
    assert.equal(result.kind, "ok");
  },
);

void test(
  "JSON limits, forwarding and protocol diagnostics identify the failure",
  { timeout: 2000 },
  async () => {
    const invoke = (response: Response) =>
      callGeometry(
        (request) => {
          assert.equal(request.body, undefined);
          assert.equal(request.contentType, undefined);
          return Promise.resolve({ kind: "response", response, start: "warm", ms: 1 });
        },
        "health",
        {
          ...call,
        },
      );
    for (const [response, violation] of [
      [
        Response.json({
          status: "ok",
          service: "geometry",
          protocol: 1,
          padding: "x".repeat(4097),
        }),
        "too_large",
      ],
      [Response.json({ error: "build_failed" }, { status: 302 }), "status"],
      [Response.json({ status: "wrong" }), "schema"],
      [new Response("{", { headers: { "content-type": "application/json" } }), "invalid_json"],
      [Response.json({ error: "unknown" }, { status: 500 }), "schema"],
    ] as const) {
      assert.deepEqual(await invoke(response), {
        kind: "failed",
        reason: "protocol_violation",
        status: response.status,
        violation,
      });
    }
    let cancelled = false;
    const stream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    assert.deepEqual(await invoke(new Response(stream)), {
      kind: "failed",
      reason: "protocol_violation",
      status: 200,
      violation: "content_type",
    });
    assert(cancelled);
  },
);
void test("sample declaration enforces the display byte limit", async () => {
  const boundary = await readSampleDisplay(
    () =>
      Promise.resolve({
        kind: "response",
        start: "warm",
        ms: 1,
        response: new Response(new Uint8Array(geometryInternal.maxDisplayBytes), {
          headers: { "content-type": geometryInternal.displayContentType },
        }),
      }),
    call,
  );
  assert.equal(boundary.kind, "ok");
  if (boundary.kind === "ok")
    assert.equal(boundary.value.bytes.byteLength, geometryInternal.maxDisplayBytes);
  const result = await readSampleDisplay(
    () =>
      Promise.resolve({
        kind: "response",
        start: "warm",
        ms: 1,
        response: new Response(new Uint8Array(geometryInternal.maxDisplayBytes + 1), {
          headers: { "content-type": geometryInternal.displayContentType },
        }),
      }),
    call,
  );
  assert.deepEqual(result, {
    kind: "failed",
    reason: "protocol_violation",
    status: 200,
    violation: "too_large",
  });
});

void test("acceptBytes and acceptJson decode generic bodies", async () => {
  const { acceptJson } = await import("../src/geometry/geometry-protocol.ts");
  const { healthSchema } = await import("@madori/contracts/geometry-internal");
  const accept = acceptJson({ schema: healthSchema, maxBytes: 4096 });
  assert.throws(() => accept.decode(new TextEncoder().encode("{}").buffer), /schema/);
  const bytes = new Uint8Array([0, 255]).buffer;
  assert.deepEqual(
    acceptBytes({ contentType: "application/snapshot", maxBytes: 2 }).decode(bytes),
    { bytes, contentType: "application/snapshot" },
  );
});

void test("route names select method, path and timeout even when callers forward wider options", async () => {
  const options = { traceId: "wider", path: "/wrong", method: "POST", timeoutMs: 1 };
  for (const [name, timeoutMs] of [
    ["health", 2000],
    ["sampleDisplay", 30000],
  ] as const) {
    const result = await callGeometry(
      (request) => {
        assert.equal(request.path, geometryInternal.routes[name].path);
        assert.equal(request.method, geometryInternal.routes[name].method);
        assert.equal(request.timeoutMs, timeoutMs);
        return Promise.resolve({ kind: "unavailable", reason: "containers_disabled" });
      },
      name,
      options,
    );
    assert.deepEqual(result, { kind: "unavailable", reason: "containers_disabled" });
  }
});

void test("contract request slots select serialization and prohibit unsafe pairings", async () => {
  const { z } = await import("zod");
  const schemas = {
    ...geometryBodySchemas,
    commandSchema: z.object({ count: z.number().default(3) }).strict(),
  };
  const routes = {
    json: {
      ...geometryInternal.routes.health,
      method: "POST",
      request: { kind: "json", schema: "commandSchema", max_bytes: 4096 },
    },
    binary: {
      ...geometryInternal.routes.sampleDisplay,
      method: "POST",
      request: { kind: "binary", content_type: "application/snapshot", max_bytes: 4096 },
    },
  } as const;
  const invoke = createGeometryCaller(routes, schemas, { json: 1, binary: 2 });
  for (const name of ["json", "binary"] as const) {
    const bytes = new Uint8Array([0, 255]);
    let sends = 0;
    const send = (request: GatewayRequest) => {
      sends += 1;
      assert.equal(request.method, "POST");
      assert.deepEqual(request.body, name === "json" ? '{"count":3}' : bytes);
      assert.equal(
        request.contentType,
        name === "json" ? "application/json" : "application/snapshot",
      );
      return Promise.resolve({ kind: "unavailable", reason: "containers_disabled" } as const);
    };
    const result =
      name === "json"
        ? await invoke(send, name, { ...call, body: {} })
        : await invoke(send, name, { ...call, body: bytes });
    assert.equal(sends, 1);
    assert.deepEqual(result, { kind: "unavailable", reason: "containers_disabled" });
  }
  // These calls are checked by tsc but never executed.
  function typeChecks() {
    const send = () =>
      Promise.resolve({ kind: "unavailable", reason: "containers_disabled" } as const);
    // @ts-expect-error A body is forbidden for a bodyless route.
    void callGeometry(send, "sampleDisplay", { ...call, body: new Uint8Array([1]) });
    // @ts-expect-error JSON input comes from the named schema.
    void invoke(send, "json", { ...call, body: { count: "wrong" } });
    // @ts-expect-error A binary request needs bytes.
    void invoke(send, "binary", { ...call, body: "wrong" });
    // @ts-expect-error The content type belongs to the route.
    void invoke(send, "binary", { ...call, body: new Uint8Array(), contentType: "wrong" });
  }
  void typeChecks;
});
void test("readiness enforces the health response contract", async () => {
  assert(
    await acceptReadinessResponse(
      Response.json({ status: "ok", service: "geometry", protocol: 1 }),
    ),
  );
  for (const response of [
    new Response('{"status":"ok","service":"geometry","protocol":1}'),
    Response.json({ status: "ok", service: "geometry", protocol: 1, padding: "x".repeat(4096) }),
    Response.json({ status: "ok", service: "geometry", protocol: 2 }),
  ])
    assert.equal(await acceptReadinessResponse(response), false);
});

void test(
  "redirect and invalid-chunk streams are cancelled with precise violations",
  { timeout: 2000 },
  async () => {
    for (const [status, invalidChunk, violation] of [
      [302, false, "status"],
      [200, true, "stream_chunk"],
    ] as const) {
      let cancelled = false;
      const stream = new ReadableStream({
        start(controller) {
          if (invalidChunk) controller.enqueue("not bytes");
        },
        cancel() {
          cancelled = true;
        },
      });
      const result = await callGeometry(
        () =>
          Promise.resolve({
            kind: "response",
            response: new Response(stream, {
              status,
              headers: { "content-type": geometryInternal.displayContentType },
            }),
            start: "warm",
            ms: 1,
          }),
        "sampleDisplay",
        call,
      );
      assert.deepEqual(result, { kind: "failed", reason: "protocol_violation", status, violation });
      assert(cancelled);
    }
  },
);

void test("bodyless response slots accept an absent content type and no bytes", async () => {
  const invoke = createGeometryCaller(
    { empty: { ...geometryInternal.routes.health, response: { kind: "none" } } },
    geometryBodySchemas,
    { empty: 1 },
  );
  const result = await invoke(
    () =>
      Promise.resolve({
        kind: "response",
        response: new Response(null, { status: 204 }),
        start: "warm",
        ms: 1,
      }),
    "empty",
    call,
  );
  assert.deepEqual(result, { kind: "ok", value: undefined, start: "warm", ms: 1 });
});

void test(
  "protocol errors require their media type on every route",
  { timeout: 2000 },
  async () => {
    for (const name of ["health", "sampleDisplay"] as const) {
      const invoke = (response: Response) =>
        callGeometry(
          () => Promise.resolve({ kind: "response", response, start: "warm", ms: 1 }),
          name,
          call,
        );
      for (const contentType of ["text/html", null]) {
        let cancelled = false;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":"build_failed"}'));
          },
          cancel() {
            cancelled = true;
          },
        });
        assert.deepEqual(
          await invoke(
            new Response(stream, {
              status: 500,
              headers: contentType ? { "content-type": contentType } : {},
            }),
          ),
          { kind: "failed", reason: "protocol_violation", status: 500, violation: "content_type" },
        );
        assert.equal(cancelled, true);
      }
    }
  },
);

void test(
  "protocol error size is bounded at the contract limit on every route",
  { timeout: 2000 },
  async () => {
    for (const name of ["health", "sampleDisplay"] as const) {
      const invoke = (response: Response) =>
        callGeometry(
          () => Promise.resolve({ kind: "response", response, start: "warm", ms: 1 }),
          name,
          call,
        );
      for (const advertised of [false, true]) {
        let cancelled = false;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '{"error":"build_failed"}'.padEnd(geometryInternal.error.max_bytes + 1, " "),
              ),
            );
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        });
        assert.deepEqual(
          await invoke(
            new Response(stream, {
              status: 500,
              headers: {
                "content-type": "application/json",
                ...(advertised
                  ? { "content-length": String(geometryInternal.error.max_bytes + 1) }
                  : {}),
              },
            }),
          ),
          { kind: "failed", reason: "protocol_violation", status: 500, violation: "too_large" },
        );
        if (advertised) assert.equal(cancelled, true);
      }
      const text = '{"error":"build_failed"}'.padEnd(geometryInternal.error.max_bytes, " ");
      assert.deepEqual(
        await invoke(
          new Response(text, { status: 500, headers: { "content-type": "application/json" } }),
        ),
        {
          kind: "failed",
          reason: "build_failed",
          status: 500,
        },
      );
    }
  },
);

void test(
  "readiness cancels wrong media types through the shared response decoder",
  { timeout: 2000 },
  async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    assert.equal(await acceptReadinessResponse(new Response(stream)), false);
    assert.equal(cancelled, true);
  },
);

void test("bundle directories account for every payload byte", async () => {
  const { acceptBundle } = await import("../src/geometry/geometry-protocol.ts");
  const policy = acceptBundle({
    schema: geometryBodySchemas.applyOperationsOutcomeSchema,
    maxBytes: 4096,
  });
  function frame(head: unknown, tail: number[]) {
    const json = new TextEncoder().encode(JSON.stringify(head));
    const bytes = new Uint8Array(16 + json.length + tail.length);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("MDBN"));
    view.setUint16(4, 1, true);
    view.setUint32(8, bytes.length, true);
    view.setUint32(12, json.length, true);
    bytes.set(json, 16);
    bytes.set(tail, 16 + json.length);
    return bytes.buffer;
  }
  const rejected = { kind: "rejected", index: 1, reason: { kind: "no_house" } };
  assert.deepEqual(policy.decode(frame(rejected, [])), rejected);
  const head = {
    kind: "applied",
    operations: [],
    inspection: { housing: [], model: [] },
    parts: [{ artifact: { kind: "house" }, byte_length: 2 }],
  };
  assert.deepEqual(policy.decode(frame(head, [1, 2])), {
    ...head,
    parts: [{ ...head.parts[0], bytes: Uint8Array.of(1, 2) }],
  });
  assert.throws(() => policy.decode(frame(rejected, [1])), /bundle/);
  assert.throws(() => policy.decode(frame(head, [1])), /bundle/);
  assert.throws(() => policy.decode(new ArrayBuffer(4)), /bundle/);
});
void test("oversize JSON is refused before send", async () => {
  const limit = geometryInternal.routes.applyOperations.request.max_bytes;
  const body = {
    job_id: "job",
    operation_id: "op",
    generation: 0,
    snapshot: { kind: "house" as const, json: "間".repeat(Math.ceil(limit / 3)) },
    operations: [],
  };
  const result = await callGeometry(() => assert.fail("unexpected send"), "applyOperations", {
    ...call,
    body,
  });
  assert.deepEqual(result, {
    kind: "failed",
    reason: "request_too_large",
    limit,
    bytes: new TextEncoder().encode(JSON.stringify(body)).byteLength,
  });
});
