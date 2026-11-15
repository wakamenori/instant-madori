export function r2(bucket: R2Bucket) {
  return {
    async putNew(
      key: string,
      bytes: Uint8Array<ArrayBuffer>,
      contentType: string,
      options?: { customMetadata: Record<string, string>; sha256: string },
    ): Promise<void> {
      const stored = await bucket.put(key, bytes, {
        ...options,
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType },
      });
      if (stored === null) throw new Error(`R2 object ${key} already exists`);
    },
    async head(key: string) {
      const object = await bucket.head(key);
      if (object === null) return null;
      const sha256 = object.checksums.sha256;
      return {
        customMetadata: object.customMetadata ?? {},
        sha256:
          sha256 === undefined
            ? null
            : Array.from(new Uint8Array(sha256), (b) => b.toString(16).padStart(2, "0")).join(""),
      };
    },
    async read(key: string) {
      const object = await bucket.get(key);
      if (object === null) return null;
      return { bytes: new Uint8Array(await object.arrayBuffer()) };
    },
  };
}

export type R2 = ReturnType<typeof r2>;
