import { geometryClient } from "./geometry/geometry-client.ts";
import { d1 } from "./storage/d1.ts";
import { r2 } from "./storage/r2.ts";
import { createStore } from "./storage/store.ts";
import type { Runtime, ServiceDeps } from "./services/deps.ts";

export function serviceDeps(
  env: Pick<Env, "DB" | "BLOBS" | "GEOMETRY">,
  runtime: Runtime,
): ServiceDeps {
  return {
    store: createStore(d1(env.DB), r2(env.BLOBS)),
    runtime,
    geometry: geometryClient((name) => env.GEOMETRY.getByName(name)),
  };
}
