import { start, stop } from "./processes.ts";
import type { ProcessOutcome } from "./processes.ts";

const processes = [
  start("cargo", ["run", "--locked", "-p", "madori-geometry"]),
  start(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      "8787",
    ],
    { cwd: "apps/worker" },
  ),
  start(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
    { cwd: "apps/web" },
  ),
];
let interrupted = false;
const interruption = new Promise<ProcessOutcome>((resolve) => {
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      interrupted = true;
      resolve({ kind: "exit", code: 0, signal: null });
    });
});
console.log(
  "Web: http://127.0.0.1:5173 | Worker: http://127.0.0.1:8787 | Geometry: http://127.0.0.1:3001/healthz",
);
const result = await Promise.race([...processes.map(({ finished }) => finished), interruption]);
await stop(processes);
if (result.kind === "error") console.error(result.error);
process.exitCode = interrupted ? 0 : result.kind === "error" ? 1 : (result.code ?? 1);
