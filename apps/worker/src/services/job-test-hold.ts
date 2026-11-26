import { z } from "zod";

type TestHoldPoint = "first_answer" | "finish_answer";
export interface JobTestHold {
  at: TestHoldPoint;
  seconds: number;
  scope: "every_job" | "verifier";
}

export const jobTestHoldSettingSchema = z
  .object({
    ENVIRONMENT: z.string(),
    JOB_TEST_HOLD: z.string().optional(),
  })
  .transform((env, context): JobTestHold | null => {
    const setting = env.JOB_TEST_HOLD;
    if (setting === undefined || setting === "none") return null;
    const match = /^(first_answer|finish_answer):([1-9][0-9]{0,3})$/u.exec(setting);
    const at = match?.[1];
    const seconds = Number(match?.[2]);
    if (
      (at !== "first_answer" && at !== "finish_answer") ||
      seconds > 7200 ||
      (env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "staging")
    ) {
      context.addIssue({
        code: "custom",
        path: ["JOB_TEST_HOLD"],
        message: "invalid job test hold",
      });
      return z.NEVER;
    }
    return { at, seconds, scope: env.ENVIRONMENT === "local" ? "every_job" : "verifier" };
  });
