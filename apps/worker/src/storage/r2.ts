export function r2(bucket: R2Bucket) {
  return {
    async putNew(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<void> {
      const stored = await bucket.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType },
      });
      if (stored === null) throw new Error("Snapshot object already exists");
    },
    async read(key: string) {
      const object = await bucket.get(key);
      if (object === null) return null;
      return { bytes: new Uint8Array(await object.arrayBuffer()) };
    },
  };
}

export type R2 = ReturnType<typeof r2>;
