import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { Socket } from "node:net";
import { mock } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openJobDatabase } from "./jobs-support.ts";

assert(globalThis.gc, "Run this fixture with --expose-gc");
const db = await openJobDatabase();
let onIntercept = () => {};
const intercepted = new Promise<void>((resolve) => {
  onIntercept = resolve;
});
// Delay only the CALL socket. FREE requests must still reach the real workerd.
const writes: (() => void)[] = [];
const blocked = new Set<Socket>();
const write = mock.method(
  Socket.prototype,
  "write",
  function (this: Socket, ...args: Parameters<Socket["write"]>): boolean {
    const chunk = args[0].toString();
    if (/MF-Op-Key: batch\r\n/iu.test(chunk)) {
      blocked.add(this);
      onIntercept();
    }
    if (blocked.has(this)) {
      writes.push(() => {
        Duplex.prototype.write.call(this, args[0], args[1] ?? "utf8", args[2]);
      });
      return true;
    }
    return Duplex.prototype.write.call(this, args[0], args[1] ?? "utf8", args[2]);
  },
);
try {
  const pending = db.raw.batch([db.raw.prepare("SELECT 269 AS value").bind()]);
  await Promise.race([
    intercepted,
    setTimeout(10000, undefined, { ref: false }).then(() => {
      throw new Error("Did not intercept the async batch CALL");
    }),
  ]);
  let collected = false;
  const registry = new FinalizationRegistry(() => {
    collected = true;
  });
  (() => {
    registry.register({}, undefined);
  })();
  for (let i = 0; i < 20; i++) {
    globalThis.gc();
    await setTimeout(25);
  }
  assert(collected, "GC must run while the batch CALL is blocked");
  await setTimeout(200);
  write.mock.restore();
  for (const send of writes.splice(0)) send();
  const result = await pending;
  assert.deepEqual(result[0]?.results, [{ value: 269 }]);
  console.log("The real D1 batch survived GC and the 100 ms FREE window");
} finally {
  write.mock.restore();
  for (const send of writes.splice(0)) send();
  await db.dispose();
}
