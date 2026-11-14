import { getPlatformProxy } from "wrangler";

export async function getTestPlatformProxy<Bindings extends object>(
  options: Parameters<typeof getPlatformProxy>[0],
) {
  const proxy = await getPlatformProxy<Bindings>(options);
  const retained = new Set<object>();
  function retain<T>(value: T): T {
    if (typeof value === "function") {
      retained.add(value);
      return new Proxy(value, {
        apply(target, receiver, args) {
          const result: unknown = Reflect.apply(target, receiver, args);
          return result instanceof Promise ? result.then(retain) : retain(result);
        },
      });
    }
    // Miniflare stubs have a null prototype. Keep the originals until dispose so
    // their finalizer cannot FREE an address still used by a call or R2 body.
    // https://github.com/cloudflare/workers-sdk/issues/16230
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== null) {
      return value;
    }
    retained.add(value);
    return new Proxy(value, {
      get(target, key) {
        return retain(Reflect.get(target, key));
      },
    });
  }

  return {
    ...proxy,
    env: new Proxy(proxy.env, {
      get(target, key) {
        return retain(Reflect.get(target, key));
      },
    }),
    async dispose() {
      try {
        await proxy.dispose();
      } finally {
        retained.clear();
      }
    },
  };
}
