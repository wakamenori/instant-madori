/// <reference lib="es2024.string" />

export { displayContentType } from "./generated/display.ts";
import { z } from "zod";

export const workerHealthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("worker"),
});

export type WorkerHealth = z.infer<typeof workerHealthSchema>;

/** The header through which Cloudflare Access (or the local dev proxy) passes its JWT. */
export const accessAssertionHeader = "cf-access-jwt-assertion";

// API conventions (plan 4.7):
// - JSON bodies with camelCase fields; IDs are UUIDs; timestamps are ISO 8601 UTC.
// - Every mutating request carries a client-generated `requestId`. Resending the same
//   ID with the same body returns the first successful result; failures are not fixed.
// - Updates to management fields send the `version` the client last saw.
// - Failures are `{ error }` with a code from `apiErrorCodeSchema`; clients branch on it.

export const apiErrorCodeSchema = z.enum([
  "unauthenticated",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "invalid_request",
  "payload_too_large",
  "version_conflict",
  "request_id_reused",
  "internal_error",
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({ error: apiErrorCodeSchema });

export type ApiError = z.infer<typeof apiErrorSchema>;

const idSchema = z.uuid();
const timestampSchema = z.iso.datetime();
const versionSchema = z.int().positive();
// Lowercased so the same UUID in another case is the same request (IDs are stored as text).
const requestIdSchema = z.uuid().transform((id) => id.toLowerCase());
// Control characters are rejected: they never belong in a name, and SQLite's length()
// stops at NUL, which would make the database's own length check fail.
// Lengths count characters (code points), as the database's length() does, not UTF-16 units.
// A name must show something: control characters are rejected, and a name made only of
// invisible format characters (e.g. U+200B) counts as empty. Lone surrogates are rejected
// because storage would silently replace them.
export const nameSchema = z
  .string()
  .trim()
  // With the `u` flag, \p{Cs} matches only unpaired surrogates (pairs form one code point).
  .refine((name) => !/\p{Cs}/u.test(name), "must be well-formed Unicode")
  .refine((name) => {
    const characters = [...name].length;
    return characters <= 100 && name.replace(/\p{Cf}/gu, "").trim() !== "";
  }, "must be 1 to 100 characters, not only invisible ones")
  .regex(/^[^\p{Cc}]*$/u, "must not contain control characters");

// Access verifies the address; a stricter syntax check here would reject valid ones.
export const userSchema = z.object({ id: idSchema, email: z.string().min(1) });

export type User = z.infer<typeof userSchema>;

export const meResponseSchema = z.object({ user: userSchema });

export type MeResponse = z.infer<typeof meResponseSchema>;

export const projectSchema = z.object({
  id: idSchema,
  name: nameSchema,
  version: versionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type Project = z.infer<typeof projectSchema>;

export const patternSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: nameSchema,
  version: versionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type Pattern = z.infer<typeof patternSchema>;

/** Query of `GET /api/projects`; `cursor` is the opaque `nextCursor` of the previous page. */
export const projectListQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(200).optional(),
});

export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

/** Newest projects first. `nextCursor` is null on the last page. */
export const projectListResponseSchema = z.object({
  projects: z.array(projectSchema),
  nextCursor: z.string().nullable(),
});

export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

export const createProjectRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  name: nameSchema.optional(),
});

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/** Creating a project also starts its first pattern. */
export const createProjectResponseSchema = z.object({
  project: projectSchema,
  pattern: patternSchema,
});

export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>;

export const renameRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  version: versionSchema,
  name: nameSchema,
});

export type RenameRequest = z.infer<typeof renameRequestSchema>;

export const projectResponseSchema = z.object({ project: projectSchema });

export type ProjectResponse = z.infer<typeof projectResponseSchema>;

/** A project has few patterns, so the list is returned whole, in creation (number) order. */
export const patternListResponseSchema = z.object({ patterns: z.array(patternSchema) });

export type PatternListResponse = z.infer<typeof patternListResponseSchema>;

export const createPatternRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  name: nameSchema.optional(),
});

export type CreatePatternRequest = z.infer<typeof createPatternRequestSchema>;

export const patternResponseSchema = z.object({ pattern: patternSchema });

export type PatternResponse = z.infer<typeof patternResponseSchema>;

export const revisionSchema = z.object({
  id: idSchema,
  patternId: idSchema,
  number: z.int().positive(),
  name: nameSchema,
  baseRevisionId: idSchema.nullable(),
  createdAt: timestampSchema,
});

export type Revision = z.infer<typeof revisionSchema>;

const conversationFields = {
  id: idSchema,
  number: z.int().positive(),
  body: z.string(),
  createdAt: timestampSchema,
  revision: revisionSchema.nullable(),
};
export const conversationMessageSchema = z.discriminatedUnion("kind", [
  z.object({ ...conversationFields, kind: z.literal("instruction"), jobId: idSchema.nullable() }),
  z.object({ ...conversationFields, kind: z.literal("answer"), jobId: idSchema.nullable() }),
  z.object({ ...conversationFields, kind: z.literal("explanation"), jobId: idSchema }),
  z.object({
    ...conversationFields,
    kind: z.literal("question"),
    jobId: idSchema,
    choices: z.array(z.string()),
  }),
  z.object({ ...conversationFields, kind: z.literal("notice"), jobId: idSchema.nullable() }),
]);
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const messageListQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(200).optional(),
});
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

/** One conversation page in descending number order. */
export const messageListResponseSchema = z.object({
  messages: z.array(conversationMessageSchema),
  nextCursor: z.string().nullable(),
});
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    bytes += character.length === 2 ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return bytes;
}

export const instructionBodySchema = z
  .string()
  .refine((body) => body.isWellFormed(), "must be well-formed Unicode")
  .refine((body) => body.trim() !== "", "must not be blank")
  .refine((body) => utf8Bytes(body) <= 16384, "must be at most 16384 UTF-8 bytes");

export const acceptInstructionRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  body: instructionBodySchema,
});

export type AcceptInstructionRequest = z.infer<typeof acceptInstructionRequestSchema>;

/** Facts fixed at acceptance. Current job state is read from the pattern's state. */
export const acceptedJobSchema = z.object({
  jobId: idSchema,
  messageId: idSchema,
  number: z.int().positive(),
});

export type AcceptedJob = z.infer<typeof acceptedJobSchema>;

export const cancelledJobSchema = acceptedJobSchema.extend({ state: z.literal("cancelled") });
export const finishedJobSchema = z.discriminatedUnion("state", [
  acceptedJobSchema.extend({ state: z.literal("completed"), revision: revisionSchema }),
  cancelledJobSchema,
  acceptedJobSchema.extend({ state: z.literal("failed") }),
]);
export type CancelledJob = z.infer<typeof cancelledJobSchema>;
export type FinishedJob = z.infer<typeof finishedJobSchema>;

export const stopJobRequestSchema = z.strictObject({ requestId: requestIdSchema });
export type StopJobRequest = z.infer<typeof stopJobRequestSchema>;
export const stopJobResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("stopped"), job: cancelledJobSchema }),
  z.object({ outcome: z.literal("already_finished"), job: finishedJobSchema }),
]);
export type StopJobResponse = z.infer<typeof stopJobResponseSchema>;

export const acceptInstructionResponseSchema = z.object({ job: acceptedJobSchema });

export type AcceptInstructionResponse = z.infer<typeof acceptInstructionResponseSchema>;

/** The job whose stop or failure holds its pattern's queue (plan 2.4). Widen with limited (5.2) and awaiting_answer (6.2). */
export const holdingJobSchema = acceptedJobSchema.extend({
  state: z.enum(["cancelled", "failed"]),
});
export type HoldingJob = z.infer<typeof holdingJobSchema>;
/** Present while the queue is held. Every job in `queuedJobs` waits for resume or cancel. */
export const queueHoldSchema = z.object({ job: holdingJobSchema });
export type QueueHold = z.infer<typeof queueHoldSchema>;

/**
 * Body of POST /api/patterns/:id/queue/resume and .../cancel. `heldBy` is `queueHold.job.jobId`
 * from the state the client saw. The request applies only while that job still holds the queue.
 */
export const releaseQueueRequestSchema = z.strictObject({
  requestId: requestIdSchema,
  heldBy: z.uuid().transform((id) => id.toLowerCase()),
});
export type ReleaseQueueRequest = z.infer<typeof releaseQueueRequestSchema>;
/** The instructions that were waiting when the hold was released, in number order. */
export const resumeQueueResponseSchema = z.object({ jobs: z.array(acceptedJobSchema) });
export type ResumeQueueResponse = z.infer<typeof resumeQueueResponseSchema>;
/** Every instruction this request cancelled, in number order. */
export const cancelQueueResponseSchema = z.object({ jobs: z.array(cancelledJobSchema) });
export type CancelQueueResponse = z.infer<typeof cancelQueueResponseSchema>;

export const patternStateQuerySchema = z.strictObject({});

export type PatternStateQuery = z.infer<typeof patternStateQuerySchema>;

export const patternStateResponseSchema = z.object({
  pattern: patternSchema,
  currentRevision: revisionSchema.nullable(),
  runningJob: acceptedJobSchema.nullable(),
  queueHold: queueHoldSchema.nullable(),
  queuedJobs: z.array(acceptedJobSchema),
  /** The finished job with the greatest message number among jobs that ran. Jobs stopped or cancelled while queued never appear. */
  lastFinishedJob: finishedJobSchema.nullable(),
});

export type PatternStateResponse = z.infer<typeof patternStateResponseSchema>;

export const revisionListQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(200).optional(),
});

export const revisionListResponseSchema = z.object({
  revisions: z.array(revisionSchema),
  nextCursor: z.string().nullable(),
});

export type RevisionListResponse = z.infer<typeof revisionListResponseSchema>;
