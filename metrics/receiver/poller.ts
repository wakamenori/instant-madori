import type { RecordInput } from "../l1/sources.ts";

export type Poller = {
  name: RecordInput["source"];
  intervalMs: number;
  poll(signal: AbortSignal): Promise<readonly RecordInput[]> | readonly RecordInput[];
  committed?(): void;
};
