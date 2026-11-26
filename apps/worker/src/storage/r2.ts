function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
        sha256: sha256 === undefined ? null : hex(sha256),
      };
    },
    async digest(key: string) {
      const object = await bucket.get(key);
      if (object === null) return null;
      const hash = new crypto.DigestStream("SHA-256");
      await object.body.pipeTo(hash);
      return { sha256: hex(await hash.digest), etag: object.etag };
    },
    async stream(key: string, etag: string) {
      const object = await bucket.get(key, { onlyIf: { etagMatches: etag } });
      return object !== null && "body" in object ? object.body : null;
    },
    async read(key: string) {
      const object = await bucket.get(key);
      if (object === null) return null;
      return { bytes: new Uint8Array(await object.arrayBuffer()) };
    },
  };
}

export type R2 = ReturnType<typeof r2>;
