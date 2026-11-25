import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dockerTetherEnv } from "../shared/docker-tether.ts";
import { repositoryRoot } from "../shared/repository.ts";
import { cleanupSteps } from "../shared/processes.ts";
import type { ProcessOutcome } from "../shared/processes.ts";

declare const brand: unique symbol;
export type Port = number & { readonly [brand]: true };

export interface DevPorts {
  readonly web: Port;
  readonly worker: Port;
}

export const defaultDevPorts: DevPorts = { web: 5173 as Port, worker: 8787 as Port };

export interface DevSession {
  readonly ports: DevPorts;
  /** verify-madori reads this run's ports from this line in its dev.log. */
  readonly banner: string;
  readonly wranglerArgs: readonly string[];
  readonly viteArgs: readonly string[];
  readonly viteEnv: Readonly<Record<"MADORI_DEV_WORKER_PORT", string>>;
}

export interface Launch {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv };
}

export function devContainersEnabled(env: NodeJS.ProcessEnv): boolean {
  return env["MADORI_DEV_CONTAINERS"] !== "0";
}

export function devServers(
  session: DevSession,
  env: NodeJS.ProcessEnv,
): readonly [wrangler: Launch, vite: Launch] {
  const jobTestHold = env["MADORI_DEV_JOB_TEST_HOLD"];
  return [
    {
      command: process.execPath,
      args: [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--local",
        ...session.wranglerArgs,
        ...(jobTestHold === undefined ? [] : ["--var", `JOB_TEST_HOLD:${jobTestHold}`]),
        ...(devContainersEnabled(env) ? [] : ["--enable-containers=false"]),
      ],
      options: { cwd: "apps/worker", env: { ...env, ...dockerTetherEnv(env) } },
    },
    {
      command: process.execPath,
      args: ["node_modules/vite/bin/vite.js", ...session.viteArgs],
      options: { cwd: "apps/web", env: { ...env, ...session.viteEnv } },
    },
  ];
}

export function devWorkerPort(env: NodeJS.ProcessEnv): Port {
  const value = env["MADORI_DEV_WORKER_PORT"];
  if (value === undefined) return defaultDevPorts.worker;
  const port = Number(value);
  if (/^[0-9]+$/.test(value) && port >= 1 && port <= 65535) return port as Port;
  throw new Error(`MADORI_DEV_WORKER_PORT must be a port number, got "${value}"`);
}

function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const occupied = () => {
      socket.destroy();
      resolve(true);
    };
    socket.once("connect", occupied);
    socket.setTimeout(1000, occupied);
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (
        error.code === "ECONNREFUSED" ||
        (host === "::1" &&
          ["EADDRNOTAVAIL", "ENETUNREACH", "EHOSTUNREACH", "EAFNOSUPPORT"].includes(
            error.code ?? "",
          ))
      )
        resolve(false);
      else reject(error);
    });
  });
}

export async function portInUse(port: Port | number): Promise<boolean> {
  return (await answers("127.0.0.1", port)) || (await answers("::1", port));
}

export async function resolveDevSession(
  env: NodeJS.ProcessEnv,
  {
    inUse = portInUse,
    random = Math.random,
  }: { inUse?: (port: Port) => Promise<boolean>; random?: () => number } = {},
): Promise<DevSession> {
  const mode = env["MADORI_DEV_PORTS"];
  let ports = defaultDevPorts;
  if (mode === undefined) {
    for (const role of ["web", "worker"] as const) {
      if (await inUse(ports[role])) {
        throw new Error(
          `Port ${ports[role]} (${role}) is in use. Stop the process that uses it, or start with MADORI_DEV_PORTS=auto.`,
        );
      }
    }
  } else if (mode === "auto") {
    // Stay below Docker's published ports (32768+) and macOS ephemeral ports (49152+).
    const first = 20000;
    const last = 32767;
    async function draw(exclude?: Port): Promise<Port> {
      for (let attempt = 0; attempt < 100; attempt++) {
        const candidate = (first + Math.floor(random() * (last - first + 1))) as Port;
        if (candidate !== exclude && !(await inUse(candidate))) return candidate;
      }
      throw new Error(`Could not find a free port in ${first}..${last} after 100 draws.`);
    }
    const web = await draw();
    ports = { web, worker: await draw(web) };
  } else {
    throw new Error(`MADORI_DEV_PORTS must be unset or "auto", got "${mode}"`);
  }
  const { web, worker } = ports;
  return {
    ports,
    banner: `Web: http://127.0.0.1:${web} | Worker: http://127.0.0.1:${worker}`,
    wranglerArgs: [
      "--ip",
      "127.0.0.1",
      "--port",
      String(worker),
      ...(mode === "auto" ? ["--inspector-port", "0"] : []),
    ],
    viteArgs: ["--host", "127.0.0.1", "--port", String(web), "--strictPort"],
    viteEnv: { MADORI_DEV_WORKER_PORT: String(worker) },
  };
}

export function holdCheckout(
  lockFile = new URL(".local/dev.lock", repositoryRoot),
  platform = process.platform,
): void {
  if (platform !== "darwin") return;
  mkdirSync(new URL("./", lockFile), { recursive: true });
  // Darwin's O_EXLOCK is absent from fs.constants. Keep the descriptor open to protect Wrangler state until exit.
  const O_EXLOCK = 0x20;
  let fd: number;
  try {
    fd = openSync(
      lockFile,
      constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK,
      0o600,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
    ) {
      const pid = readFileSync(lockFile, "utf8").trim();
      throw new Error(`pnpm dev is already running in this checkout (pid ${pid}). Stop it first.`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, String(process.pid));
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export async function finishDevelopment(
  result: ProcessOutcome,
  stoppedByUser: boolean,
  stop: () => void | Promise<void>,
): Promise<void> {
  // Fix the outcome before shutdown can fail or receive another interrupt.
  process.exitCode = stoppedByUser ? 0 : result.kind === "error" ? 1 : (result.code ?? 1);
  if (result.kind === "error") console.error(result.error);
  for (const error of await cleanupSteps([stop])) console.error(error);
}
