type AssetImage = { kind: "loading" } | { kind: "ready"; url: string } | { kind: "failed" };

type Entry = { image: AssetImage; controller?: AbortController };

export function createAssetImages(fetchAsset: (id: string, signal: AbortSignal) => Promise<Blob>) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let disposed = false;

  function publish() {
    for (const listener of listeners) listener();
  }

  function seed(id: string, blob: Blob) {
    const previous = entries.get(id);
    if (disposed || previous?.image.kind === "ready") return;
    previous?.controller?.abort();
    entries.set(id, { image: { kind: "ready", url: URL.createObjectURL(blob) } });
    publish();
  }

  return {
    subscribe(this: void, listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: (id: string) => entries.get(id)?.image,
    async load(id: string) {
      if (disposed || entries.has(id)) return;
      const controller = new AbortController();
      const entry: Entry = { image: { kind: "loading" }, controller };
      entries.set(id, entry);
      publish();
      try {
        const blob = await fetchAsset(id, controller.signal);
        if (!controller.signal.aborted) seed(id, blob);
      } catch {
        if (controller.signal.aborted) return;
        entries.set(id, { image: { kind: "failed" } });
        publish();
      }
    },
    seed,
    dispose() {
      disposed = true;
      for (const { image, controller } of entries.values()) {
        controller?.abort();
        if (image.kind === "ready") URL.revokeObjectURL(image.url);
      }
      entries.clear();
      publish();
      listeners.clear();
    },
  };
}

export type AssetImages = ReturnType<typeof createAssetImages>;
