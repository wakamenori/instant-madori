import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { original, prefix } from "./protocol.ts";
import type { Step } from "./protocol.ts";

export const credentialsSchema = z.object({
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1),
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/u),
});

const timeoutMs = 30_000;
const retryWaitsMs = [1_000, 2_000];

function transient(outcome: Response | TypeError) {
  return outcome instanceof TypeError || outcome.status >= 500;
}

export function stagingR2Rest(
  credentials: z.infer<typeof credentialsSchema>,
  bucket: string,
  fetcher: typeof fetch = fetch,
  delay: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) =>
    sleep(ms, undefined, { signal }),
) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${credentials.CLOUDFLARE_ACCOUNT_ID}`;
  const headers = { authorization: `Bearer ${credentials.CLOUDFLARE_API_TOKEN}` };
  const objects = `/r2/buckets/${encodeURIComponent(bucket)}/objects`;
  async function get(path: string): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    const send = () =>
      fetcher(`${base}${path}`, { method: "GET", headers, signal }).catch((error: unknown) => {
        if (error instanceof TypeError && error.message === "fetch failed") return error;
        throw error;
      });
    let outcome = await send();
    for (const [retry, wait] of retryWaitsMs.entries()) {
      if (!transient(outcome)) break;
      if (outcome instanceof Response) await outcome.body?.cancel().catch(() => undefined);
      try {
        await delay(wait, signal);
      } catch {
        break;
      }
      const failure =
        outcome instanceof Response ? `returned ${outcome.status}` : "failed with a network error";
      console.log(
        `::warning title=R2 check REST retry::REST ${path} ${failure}; waited ${wait} ms, sending attempt ${retry + 2} of ${retryWaitsMs.length + 1}`,
      );
      try {
        outcome = await send();
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") break;
        throw error;
      }
    }
    if (outcome instanceof TypeError) throw outcome;
    return outcome;
  }
  async function json(path: string) {
    const response = await get(path);
    assert.equal(response.status, 200, `REST ${path} must succeed`);
    const body: unknown = await response.json();
    return body;
  }
  return {
    async scripts() {
      const data = z
        .object({ success: z.literal(true), result: z.array(z.object({ id: z.string() })) })
        .parse(await json("/workers/scripts"));
      return data.result.map(({ id }) => id).sort();
    },
    async recover(now = Date.now()) {
      const stale: string[] = [];
      let cursor = "";
      const cursors = new Set<string>();
      let more = true;
      while (more) {
        const query = new URLSearchParams({
          prefix,
          per_page: "1000",
          ...(cursor ? { cursor } : {}),
        });
        const page = z
          .object({
            success: z.literal(true),
            result: z.array(
              z.object({ key: z.string(), last_modified: z.iso.datetime({ offset: true }) }),
            ),
            result_info: z
              .object({ is_truncated: z.boolean(), cursor: z.string().optional() })
              .optional(),
          })
          .parse(await json(`${objects}?${query.toString()}`));
        for (const object of page.result) {
          assert(object.key.startsWith(prefix), "REST list must stay within the probe prefix");
          if (Date.parse(object.last_modified) < now - 3_600_000) stale.push(object.key);
        }
        assert(
          page.result_info || page.result.length < 1000,
          "full REST page requires pagination metadata",
        );
        more = page.result_info?.is_truncated ?? false;
        if (!more) break;
        assert(
          page.result_info?.cursor && !cursors.has(page.result_info.cursor),
          "REST pagination must advance",
        );
        cursor = page.result_info.cursor;
        cursors.add(cursor);
      }
      for (const key of stale) {
        const response = await fetcher(`${base}${objects}/${encodeURIComponent(key)}`, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        assert(response.ok, `REST recovery delete must succeed (${response.status})`);
        assert.equal(
          (await get(`${objects}/${encodeURIComponent(key)}`)).status,
          404,
          "recovered key must be absent",
        );
        console.log(`REST recovered stale probe: ${key}`);
      }
      console.log(`REST recovery passed: ${stale.length} stale probes deleted`);
    },
    async observe(key: string, step: Step) {
      const response = await get(`${objects}/${encodeURIComponent(key)}`);
      if (step === "delete") {
        assert.equal(response.status, 404, "REST must confirm deletion");
        console.log(`REST ${step}: 404, key absent`);
      } else {
        assert.equal(response.status, 200, "REST must read the real staging object");
        assert.deepEqual(
          new Uint8Array(await response.arrayBuffer()),
          original,
          "REST must read original bytes",
        );
        console.log(`REST ${step}: 200, original bytes ${Array.from(original).join(",")}`);
      }
    },
  };
}
