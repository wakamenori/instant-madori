import { z } from "zod";
import { describeError, type LogFields } from "../log.ts";
// A fresh DO needs this margin so its idle alarm runs before the runtime stops its Container.
export const containerInactivityMarginMs = 60_000;
type InstanceType = "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";
// No monitor(): a pending one keeps the DO invocation open until the Container exits.
// The runtime updates `running` without holding the invocation.
export interface ContainerHandle {
  readonly running: boolean;
  readonly images: Readonly<Record<string, string>>;
  start(options: {
    image: string;
    enableInternet: false;
    env: Record<string, string>;
    instance: InstanceType;
  }): void;
  destroy(reason: string): Promise<void>;
  setInactivityTimeout(ms: number): Promise<void>;
  fetchPort(request: Request): Promise<Response>;
}
export interface StartRecord {
  token: string;
  image: string;
  startedAt: number;
}
export interface GatewayStore {
  read(): unknown;
  write(record: StartRecord): void;
  clear(): void;
  readStopRetry(): unknown;
  writeStopRetry(ms: number): void;
  clearStopRetry(): void;
  readActivity(): unknown;
  writeActivity(at: number): void;
  clearActivity(): void;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
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
export interface Deadline {
  readonly signal: AbortSignal;
  clear(): void;
}
export interface GatewayEnvironment {
  now(): number;
  sleep(ms: number): Promise<void>;
  // Each pending runtime timer keeps a DO invocation open until it fires or is cleared.
  deadline(ms: number): Deadline;
  newToken(): string;
  log(event: string, fields: LogFields, level?: "info" | "error"): void;
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
type Ready = { kind: "ready"; record: StartRecord; generation: number; start: "cold" | "warm" };

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
  #active = 0;
  private readonly container: ContainerHandle | undefined;
  private readonly store: GatewayStore;
  private readonly settings: GatewaySettings;
  private readonly environment: GatewayEnvironment;
  constructor(
    container: ContainerHandle | undefined,
    store: GatewayStore,
    settings: GatewaySettings,
    environment: GatewayEnvironment,
  ) {
    this.container = container;
    this.store = store;
    this.settings = settings;
    this.environment = environment;
  }
  async resume(): Promise<void> {
    if (!this.container?.running) {
      await this.#forget();
      return;
    }
    await this.container.setInactivityTimeout(
      this.settings.idleTimeoutMs + containerInactivityMarginMs,
    );
    await this.store.setAlarm(this.#activity() + this.settings.idleTimeoutMs);
  }
  /** The operation awaits every send it starts and consumes or cancels each response body. */
  async run<T>(
    operation: (send: (request: GatewayRequest) => Promise<GatewayResult>) => Promise<T>,
  ): Promise<T> {
    const deadlines: Deadline[] = [];
    ++this.#active;
    try {
      while (this.#resetting) await this.#resetting;
      if (this.container) await this.#touch();
      return await operation((request) => this.#send(request, deadlines));
    } finally {
      for (const deadline of deadlines) deadline.clear();
      while (this.#resetting) await this.#resetting;
      --this.#active;
      if (this.container?.running) {
        try {
          await this.container.setInactivityTimeout(
            this.settings.idleTimeoutMs + containerInactivityMarginMs,
          );
        } catch (error) {
          this.environment.log(
            "container.inactivity_failed",
            { error: describeError(error) },
            "error",
          );
        }
        await this.#touch();
      } else if (this.#active === 0) await this.#forget();
    }
  }
  async alarm(): Promise<void> {
    if (this.#resetting) {
      await this.#resetting;
      return;
    }
    const container = this.container;
    if (!container?.running) {
      await this.#forget();
      return;
    }
    const now = this.environment.now();
    const lastActivityAt = this.#activity();
    if (this.#active > 0) {
      await this.store.setAlarm(now + this.settings.idleTimeoutMs);
      return;
    }
    const deadline = lastActivityAt + this.settings.idleTimeoutMs;
    if (now < deadline) {
      await this.store.setAlarm(deadline);
      return;
    }
    ++this.#generation;
    this.#ready = null;
    const resetting = (async () => {
      try {
        await container.destroy("idle timeout");
      } catch {
        this.environment.log("container.destroy_failed", { reason: "idle_timeout" }, "error");
        const retry = z
          .number()
          .finite()
          .positive()
          .max(this.settings.idleTimeoutMs)
          .safeParse(this.store.readStopRetry());
        const delay = retry.success ? retry.data : 1_000;
        await this.store.setAlarm(this.environment.now() + delay);
        this.store.writeStopRetry(Math.min(delay * 2, this.settings.idleTimeoutMs));
        return;
      }
      await this.#forget();
      this.environment.log("container.idle_stopped", {
        ms: this.environment.now() - lastActivityAt,
      });
    })().finally(() => {
      if (this.#resetting === resetting) this.#resetting = null;
    });
    this.#resetting = resetting;
    await resetting;
  }
  #activity(): number {
    const now = this.environment.now();
    const stored = z.number().finite().nonnegative().safeParse(this.store.readActivity());
    if (stored.success && stored.data <= now) return stored.data;
    this.store.writeActivity(now);
    return now;
  }
  async #touch(): Promise<void> {
    const now = this.environment.now();
    this.store.writeActivity(now);
    this.store.clearStopRetry();
    await this.store.setAlarm(now + this.settings.idleTimeoutMs);
  }
  async #forget(): Promise<void> {
    this.#ready = null;
    this.store.clear();
    this.store.clearActivity();
    this.store.clearStopRetry();
    await this.store.deleteAlarm();
  }
  async #send(request: GatewayRequest, deadlines: Deadline[]): Promise<GatewayResult> {
    const container = this.container;
    if (!container) return { kind: "unavailable", reason: "containers_disabled" };
    const started = this.environment.now();
    const ready = await this.#ensure(container, request.traceId);
    if (ready.kind === "unavailable") return ready;
    try {
      const headers = new Headers();
      headers.set(this.settings.authorizationHeader, `Bearer ${ready.record.token}`);
      headers.set(this.settings.traceHeader, request.traceId);
      if (request.contentType) headers.set("content-type", request.contentType);
      const deadline = this.environment.deadline(request.timeoutMs);
      deadlines.push(deadline);
      const response = await container.fetchPort(
        new Request(`http://container${request.path}`, {
          method: request.method,
          headers,
          signal: deadline.signal,
          ...(request.body === undefined ? {} : { body: request.body }),
        }),
      );
      if (response.status === 401) {
        await response.body?.cancel();
        await this.#reset(container, ready.generation, "token_rejected", request.traceId);
        return { kind: "unavailable", reason: "token_rejected" };
      }
      return {
        kind: "response",
        response,
        start: ready.start,
        ms: this.environment.now() - started,
      };
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
    if (this.#ready) return { ...this.#ready, start: "warm" };
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
    reason: UnavailableReason,
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
    let mode: LogFields["mode"] = generation === 1 ? "adopted" : "reprobe";
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
      await container.setInactivityTimeout(
        this.settings.idleTimeoutMs + containerInactivityMarginMs,
      );
    } catch {
      await this.#reset(container, generation, "start_failed", traceId);
      return { kind: "unavailable", reason: "start_failed" };
    }
    const probe = async (): Promise<"ready" | "exited" | "protocol_mismatch" | "not_ready"> => {
      const policy = this.settings.readiness;
      while (container.running) {
        if (this.environment.now() - started >= policy.deadlineMs) return "not_ready";
        const deadline = this.environment.deadline(policy.probeTimeoutMs);
        try {
          const response = await container.fetchPort(
            new Request(`http://container${policy.path}`, { signal: deadline.signal }),
          );
          if (response.ok) {
            const healthy = await policy.acceptHealth(response);
            if (!container.running) return "exited";
            return healthy ? "ready" : "protocol_mismatch";
          }
          await response.body?.cancel();
        } catch {
          /* The process may not have bound its port yet. */
        } finally {
          deadline.clear();
        }
        if (container.running) await this.environment.sleep(policy.intervalMs);
      }
      return "exited";
    };
    const outcome = await probe();
    if (outcome !== "ready") {
      await this.#reset(container, generation, outcome, traceId);
      return { kind: "unavailable", reason: outcome };
    }
    this.environment.log("container.ready", {
      traceId,
      mode,
      ms: this.environment.now() - started,
    });
    return { kind: "ready", record, generation, start: mode === "cold" ? "cold" : "warm" };
  }
}
