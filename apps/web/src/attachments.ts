// Mirrors apps/worker/src/limits.ts. The server still enforces these limits.
export const attachmentLimits = {
  maxPerInstruction: 3,
  maxBytes: 7_499_997,
  maxEdgePx: 2_576,
};

export type AttachmentFailure = { kind: "failed"; message: string; retryable: boolean };

export type AttachmentDraft = {
  key: string;
  requestId: string;
  previewUrl: string;
  blob: Blob;
  state: { kind: "uploading" } | { kind: "ready"; assetId: string } | AttachmentFailure;
};
