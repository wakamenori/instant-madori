import { z } from "zod";

export const workerHealthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("worker"),
});

export type WorkerHealth = z.infer<typeof workerHealthSchema>;
