import { z } from "zod";
type InstanceType = "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";
export interface ContainerHandle {
  readonly running: boolean;
  readonly images: Readonly<Record<string, string>>;
  start(options: {
    image: string;
    enableInternet: false;
    env: Record<string, string>;
    instance: InstanceType;
  }): void;
  monitor(): Promise<void>;
  destroy(reason: string): Promise<void>;
  setInactivityTimeout(ms: number): Promise<void>;
  fetchPort(request: Request): Promise<Response>;
}
export interface StartRecord {
  token: string;
  image: string;
  startedAt: number;
}
export interface StartRecordStore {
  read(): unknown;
  write(record: StartRecord): void;
  clear(): void;
}
export interface GatewaySettings {
  imageName: string;
  instance: InstanceType;
  idleTimeoutMs: number;
  tokenEnv: string;
  authorizationHeader: string;
  traceHeader: string;
  readiness: {
    path: string;
    acceptHealth(response: Response): Promise<boolean>;
    deadlineMs: number;
    probeTimeoutMs: number;
    intervalMs: number;
  };
}
export interface GatewayEnvironment {
  now(): number;
  sleep(ms: number): Promise<void>;
  newToken(): string;
  log(event: string, fields: Record<string, string | number>, level?: "info" | "error"): void;
}
export interface GatewayRequest {
  method: "GET" | "POST";
  path: string;
  traceId: string;
  timeoutMs: number;
  body?: ArrayBuffer | Uint8Array<ArrayBuffer> | string;
  contentType?: string;
}
export type UnavailableReason =
  | "containers_disabled"
  | "start_failed"
  | "exited"
  | "not_ready"
  | "protocol_mismatch"
  | "token_rejected"
  | "unreachable";
type Unavailable = { kind: "unavailable"; reason: UnavailableReason };
export type GatewayResult =
  { kind: "response"; response: Response; start: "cold" | "warm"; ms: number } | Unavailable;
type Ready = { kind: "ready"; record: StartRecord; generation: number };

const startRecordSchema = z.object({
  token: z.string().min(1),
  image: z.string().min(1),
  startedAt: z.number().finite(),
});
/** Owns one container lifetime; it never retries an operation request. */
export class ContainerGateway {
  #ready: Ready | null = null;
  #starting: Promise<Ready | Unavailable> | null = null;
  #generation = 0;
  #resetting: Promise<void> | null = null;
  private readonly container: ContainerHandle | undefined;
  private readonly store: StartRecordStore;
  private readonly settings: GatewaySettings;
  private readonly environment: GatewayEnvironment;
  constructor(
    container: ContainerHandle | undefined,
    store: StartRecordStore,
    settings: GatewaySettings,
    environment: GatewayEnvironment,
  ) {
    this.container = container;
    this.store = store;
    this.settings = settings;
    this.environment = environment;
  }
  async resume(): Promise<void> {
    if (this.container?.running)
      await this.container.setInactivityTimeout(this.settings.idleTimeoutMs);
  }
  async send(request: GatewayRequest): Promise<GatewayResult> {
    const container = this.container;
    if (!container) return { kind: "unavailable", reason: "containers_disabled" };
    const started = this.environment.now();
    const start = this.#ready && container.running ? "warm" : "cold";
    const ready = await this.#ensure(container, request.traceId);
    if (ready.kind === "unavailable") return ready;
    try {
      const headers = new Headers();
      headers.set(this.settings.authorizationHeader, `Bearer ${ready.record.token}`);
      headers.set(this.settings.traceHeader, request.traceId);
      if (request.contentType) headers.set("content-type", request.contentType);
      const response = await container.fetchPort(
        new Request(`http://container${request.path}`, {
          method: request.method,
          headers,
          signal: AbortSignal.timeout(request.timeoutMs),
          ...(request.body === undefined ? {} : { body: request.body }),
        }),
      );
      if (response.status === 401) {
        await response.body?.cancel();
        await this.#reset(container, ready.generation, "token_rejected", request.traceId);
        return { kind: "unavailable", reason: "token_rejected" };
      }
      return { kind: "response", response, start, ms: this.environment.now() - started };
    } catch {
      if (ready.generation === this.#generation) {
        this.#ready = null;
      }
      return { kind: "unavailable", reason: "unreachable" };
    }
  }
  async #ensure(container: ContainerHandle, traceId: string): Promise<Ready | Unavailable> {
    if (this.#starting) return this.#starting;
    while (this.#resetting) await this.#resetting;
    if (this.#starting) return this.#starting;
    if (!container.running) this.#ready = null;
    if (this.#ready) return this.#ready;
    const starting = this.#prepare(container, traceId);
    this.#starting = starting;
    try {
      const ready = await starting;
      if (ready.kind === "ready" && ready.generation === this.#generation) this.#ready = ready;
      return ready;
    } finally {
      if (this.#starting === starting) this.#starting = null;
    }
  }
  #reset(
    container: ContainerHandle,
    generation: number,
    reason: string,
    traceId: string,
  ): Promise<void> {
    if (generation !== this.#generation) return Promise.resolve();
    ++this.#generation;
    this.#ready = null;
    this.store.clear();
    const resetting = container
      .destroy(reason)
      .catch(() => {
        this.environment.log("container.destroy_failed", { reason, traceId }, "error");
      })
      .finally(() => {
        if (this.#resetting === resetting) {
          this.#resetting = null;
          this.#ready = null;
        }
      });
    this.#resetting = resetting;
    return resetting;
  }
  async #prepare(container: ContainerHandle, traceId: string): Promise<Ready | Unavailable> {
    const started = this.environment.now();
    const generation = ++this.#generation;
    let record: StartRecord | undefined;
    let mode = generation === 1 ? "adopted" : "reprobe";
    const image = container.images[this.settings.imageName];
    try {
      const stored = this.store.read();
      const parsed = startRecordSchema.safeParse(stored);
      if (parsed.success) record = parsed.data;
      else if (stored !== undefined) {
        this.environment.log("container.invalid_record", { traceId }, "error");
        this.store.clear();
      }
      if (!image) throw new Error("Missing container image");
      if (container.running && (!record || record.image !== image)) {
        this.environment.log("container.replaced", {
          traceId,
          why: record ? "stale_image" : "no_record",
        });
        await container.destroy("deployment image changed or start record missing");
        record = undefined;
      }
      if (!container.running) {
        mode = "cold";
        record = { token: this.environment.newToken(), image, startedAt: this.environment.now() };
        this.store.write(record);
        container.start({
          image,
          enableInternet: false,
          env: { [this.settings.tokenEnv]: record.token },
          instance: this.settings.instance,
        });
        this.environment.log("container.started", { traceId, image });
      } else {
        this.environment.log("container.adopted", { traceId });
      }
      if (!record) throw new Error("Missing start record");
      await container.setInactivityTimeout(this.settings.idleTimeoutMs);
    } catch {
      await this.#reset(container, generation, "start_failed", traceId);
      return { kind: "unavailable", reason: "start_failed" };
    }
    const monitoredToken = record.token;
    let exited = false;
    const exit = container
      .monitor()
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        exited = true;
        if (
          this.#generation === generation &&
          startRecordSchema.safeParse(this.store.read()).data?.token === monitoredToken
        ) {
          this.store.clear();
          this.#ready = null;
        }
        this.environment.log("container.exited", { traceId });
        return "exited" as const;
      });
    const probe = async (): Promise<"ready" | "protocol_mismatch" | "not_ready"> => {
      const policy = this.settings.readiness;
      while (this.environment.now() - started < policy.deadlineMs && !exited) {
        try {
          const response = await container.fetchPort(
            new Request(`http://container${policy.path}`, {
              signal: AbortSignal.timeout(policy.probeTimeoutMs),
            }),
          );
          if (response.ok) {
            return (await policy.acceptHealth(response)) ? "ready" : "protocol_mismatch";
          }
          await response.body?.cancel();
        } catch {
          /* The process may not have bound its port yet. */
        }
        if (!exited) await this.environment.sleep(policy.intervalMs);
      }
      return "not_ready";
    };
    const outcome = await Promise.race([exit, probe()]);
    if (outcome !== "ready" || exited) {
      const reason = exited ? "exited" : outcome === "ready" ? "exited" : outcome;
      await this.#reset(container, generation, reason, traceId);
      return { kind: "unavailable", reason };
    }
    this.environment.log("container.ready", {
      traceId,
      mode,
      ms: this.environment.now() - started,
    });
    return { kind: "ready", record, generation };
  }
}
