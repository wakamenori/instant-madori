import { z } from "zod";

export const prefix = "checks/r2-create-only/";
export const original = new Uint8Array([0, 1, 127, 128, 255]);
export const stepSchema = z.enum(["first", "reject", "direct", "delete"]);
export type Step = z.infer<typeof stepSchema>;
export const replySchema = z.object({ ok: z.literal(true), step: stepSchema, key: z.string() });

export async function verifyCreateOnly(
  invoke: (step: Step) => Promise<void>,
  observe: (step: Step) => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    for (const step of ["first", "reject", "direct"] satisfies Step[]) {
      await invoke(step);
      await observe(step);
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await invoke("delete");
    await observe("delete");
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, "R2 create-only verification failed");
}
