import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { metricsHome } from "../home.ts";
import { parseHook } from "../ingest/hook-record.ts";
import { parseOtlp } from "../ingest/otlp.ts";
import { registry, type RecordInput, type Parsed } from "../l1/sources.ts";
import { openL1Writer } from "../l1/store.ts";
import { codexProof } from "./t3.ts";
import type { Obj } from "../l1/envelope.ts";

type Poller = {
  name: string;
  intervalMs: number;
  poll(signal: AbortSignal): Promise<readonly RecordInput[]>;
};
type Options = {
  home: ReturnType<typeof metricsHome>;
  identity: string;
  port: number;
  clock?: () => Date;
  t3File?: string;
  pollers?: readonly Poller[];
};
export async function startReceiver(options: Options) {
  const { home, identity } = options,
    clock = options.clock ?? (() => new Date());
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  function open() {
    mkdirSync(home.root, { recursive: true, mode: 0o700 });
    return openL1Writer(home.database, registry);
  }
  let store: ReturnType<typeof open>;
  try {
    store = open();
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  let sources: Record<string, Obj> = {},
    failures: Record<string, number> = {};
  const increment = (key: string) => {
    failures[key] = (failures[key] ?? 0) + 1;
  };
  function count(source: string, field: string, n: number) {
    const tally = (sources[source] ??= {});
    tally[field] = Number(tally[field] ?? 0) + n;
  }
  function ingest(parsed: Parsed) {
    const at = clock().toISOString(),
      proofs = new Map<string, RecordInput | "foreign" | null>();
    const records = parsed.records.filter((c) => {
      if (
        c.scope.kind !== "gated" ||
        !c.scope.subject.startsWith("codex.conversation:") ||
        store.admitted(c.scope.subject)
      )
        return true;
      const id = c.scope.subject.slice("codex.conversation:".length);
      if (!proofs.has(id)) {
        try {
          proofs.set(
            id,
            codexProof(
              options.t3File ?? join(homedir(), ".t3/userdata/statev2.sqlite"),
              dirname(identity),
              id,
            ),
          );
        } catch {
          increment("t3_failures");
          proofs.set(id, null);
        }
      }
      if (proofs.get(id) === "foreign") {
        parsed.drops.push({ source: c.source, reason: "foreign" });
        return false;
      }
      return true;
    });
    const tallies = store.ingest(
      [...Array.from(proofs.values()).filter((p) => p !== null && p !== "foreign"), ...records],
      at,
      parsed.rejects,
    );
    for (const [source, tally] of Object.entries(tallies)) {
      for (const [key, value] of Object.entries(tally)) count(source, key, value);
      (sources[source] ??= {}).last_batch_at = at;
    }
    for (const drop of parsed.drops) count(drop.source, "dropped_" + drop.reason, 1);
  }
  function drain() {
    for (const name of readdirSync(home.tmp))
      if (clock().getTime() - statSync(join(home.tmp, name)).mtimeMs > 3600_000)
        unlinkSync(join(home.tmp, name));
    for (const name of readdirSync(home.ready).sort()) {
      const path = join(home.ready, name);
      ingest(parseHook(readFileSync(path), identity));
      unlinkSync(path);
    }
  }
  function flush() {
    drain();
    const at = clock().toISOString();
    for (const row of store.expire(at)) count(String(row.source), "expired", 1);
    for (const id of store.pendingCodex()) {
      let proof;
      try {
        proof = codexProof(
          options.t3File ?? join(homedir(), ".t3/userdata/statev2.sqlite"),
          dirname(identity),
          id,
        );
      } catch {
        increment("t3_failures");
        break;
      }
      if (proof && proof !== "foreign") ingest({ records: [proof], rejects: [], drops: [] });
    }
    store.ingest(
      [
        {
          source: "metrics.receiver",
          sourceVersion: "1",
          naturalKey: randomUUID(),
          occurredAt: at,
          scope: { kind: "repo" },
          payload: { sources, ...failures, spool_pending: readdirSync(home.ready).length },
        },
      ],
      at,
    );
    sources = {};
    failures = {};
  }
  try {
    for (const dir of [home.tmp, home.ready]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    drain();
  } catch (error) {
    server.close();
    store.close();
    throw error;
  }
  async function request(req: IncomingMessage, res: ServerResponse) {
    function reply(status: number, data: unknown = {}) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    }
    try {
      if (req.method === "GET" && req.url === "/health") return reply(200, store.health());
      if (req.method !== "POST" || (req.url !== "/v1/logs" && req.url !== "/v1/metrics"))
        return reply(404);
      if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
        increment("unsupported_media");
        return reply(415);
      }
      const limit = 16 * 1024 * 1024,
        buffers: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        if (!Buffer.isBuffer(chunk)) throw new Error("Expected bytes");
        size += chunk.length;
        if (size > limit) return reply(413);
        buffers.push(chunk);
      }
      let body: Buffer = Buffer.concat(buffers);
      if (req.headers["content-encoding"] === "gzip") {
        try {
          body = gunzipSync(body, { maxOutputLength: limit });
        } catch (error) {
          return reply(
            error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ERR_BUFFER_TOO_LARGE"
              ? 413
              : 400,
          );
        }
      }
      const parsed = parseOtlp(req.url === "/v1/logs" ? "logs" : "metrics", body);
      ingest(parsed);
      reply(parsed.rejects.some((r) => r.reason === "invalid_json") ? 400 : 200);
    } catch {
      increment("store_failures");
      reply(503);
    }
  }
  server.on("request", (req, res) => {
    void request(req, res);
  });
  function periodic(work: () => void, ms: number) {
    return setInterval(() => {
      try {
        work();
      } catch {
        increment("store_failures");
      }
    }, ms);
  }
  const timers = [periodic(drain, 1000), periodic(flush, 60000)],
    controller = new AbortController();
  for (const p of options.pollers ?? []) {
    let active = false;
    timers.push(
      periodic(() => {
        if (active) return;
        active = true;
        void p
          .poll(controller.signal)
          .then((records) => {
            if (!controller.signal.aborted)
              ingest({ records: [...records], rejects: [], drops: [] });
          })
          .catch(() => increment("poll_failures"))
          .finally(() => {
            active = false;
          });
      }, p.intervalMs),
    );
  }
  return {
    url: "http://127.0.0.1:" + address.port,
    flush,
    async close() {
      for (const t of timers) clearInterval(t);
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        flush();
      } finally {
        store.close();
      }
    },
  };
}
if (import.meta.main) {
  const identity = execFileSync(
    "git",
    ["-C", import.meta.dirname, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim();
  const receiver = await startReceiver({
    home: metricsHome(process.env),
    identity,
    port: 4318,
    pollers: [],
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      void receiver.close();
    });
}
