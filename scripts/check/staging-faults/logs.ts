import assert from "node:assert/strict";
import { z } from "zod";
import type { credentialsSchema } from "../r2-create-only/rest.ts";
const nullable = z
  .string()
  .nullish()
  .transform((value) => value ?? null);
const sourceSchema = z.object({
  event: z.string(),
  jobId: nullable,
  step: nullable,
  outcome: nullable,
  instanceStatus: nullable,
  attempt: z
    .number()
    .nullish()
    .transform((n) => n ?? null),
  reason: nullable,
  revisionId: nullable,
  image: nullable,
  mode: nullable,
  why: nullable,
});
export interface LogLine extends z.output<typeof sourceSchema> {
  at: number;
  version: string;
}
export type LogExpectation =
  | { kind: "committed"; jobId: string }
  // A hold line proves the stop came after the hold decision: a job stopped earlier logs "skip".
  | { kind: "stopped"; jobId: string; held: boolean }
  | { kind: "restart"; jobId: string; deployStepCompletedAt: number };
type Restart = { from: string; to: string; firstNewAt: number; workflowVersion: string };
export type LogVerdict =
  | { kind: "pass"; restart: Restart }
  | { kind: "pending"; waitingFor: string[] }
  | { kind: "missed"; why: string }
  | { kind: "failed"; reasons: string[] };
export function judgeLogs(
  lines: readonly LogLine[],
  expectations: readonly LogExpectation[],
): LogVerdict {
  const reasons = lines
    .filter(
      (l) =>
        l.event === "pattern.advance_failed" ||
        (l.event === "pattern.advanced" && (l.outcome === "failed" || l.outcome === "stalled")) ||
        (l.event === "job.finished" && l.outcome !== "committed" && l.outcome !== "cancelled"),
    )
    .map((l) => `${l.event} ${l.outcome ?? ""} ${l.jobId ?? ""}`);
  const waitingFor: string[] = [];
  let restart: Restart | undefined;
  let why = "Migrate and deploy ended before the held job was sent";
  for (const expectation of expectations) {
    const job = lines.filter((l) => l.jobId === expectation.jobId).sort((a, b) => a.at - b.at);
    const finishes = job.filter((l) => l.event === "job.finished");
    const outcome = expectation.kind === "stopped" ? "cancelled" : "committed";
    if (finishes.some((l) => l.outcome !== outcome))
      reasons.push(`${expectation.jobId} expected ${outcome} finish`);
    const finish = finishes.find((l) => l.outcome === outcome);
    if (!finish) waitingFor.push(`${expectation.jobId} ${outcome} finish`);
    if (
      expectation.kind === "stopped" &&
      expectation.held &&
      finish &&
      !job.some(
        (l) =>
          l.event === "job.step" &&
          l.step === "check test hold before render" &&
          l.outcome === "hold",
      )
    )
      reasons.push(`${expectation.jobId} missing hold before stop`);
    if (expectation.kind !== "restart") continue;
    const claim = job.find((l) => l.event === "pattern.advanced" && l.outcome === "claimed");
    if (!claim) {
      waitingFor.push(`${expectation.jobId} claim`);
      continue;
    }
    if (!finish) continue;
    const running = job.find(
      (l) =>
        l.at >= claim.at &&
        l.at < finish.at &&
        l.event === "pattern.advanced" &&
        l.outcome === "running" &&
        l.instanceStatus !== null &&
        l.version !== claim.version,
    );
    if (claim.at >= expectation.deployStepCompletedAt) why = "job claimed after deployment";
    else if (!running) why = "no new DO version observed before commit";
    else
      restart = {
        from: claim.version,
        to: running.version,
        firstNewAt: running.at,
        workflowVersion: finish.version,
      };
  }
  if (reasons.length) return { kind: "failed", reasons };
  if (waitingFor.length) return { kind: "pending", waitingFor };
  return restart ? { kind: "pass", restart } : { kind: "missed", why };
}
export async function queryLogs(
  io: { fetcher: typeof fetch; credentials: z.infer<typeof credentialsSchema> },
  filter: {
    service: string;
    key: "patternId" | "traceId";
    value: string;
    from: number;
    to: number;
  },
): Promise<LogLine[]> {
  const limit = 2000;
  const response = await io.fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${io.credentials.CLOUDFLARE_ACCOUNT_ID}/workers/observability/telemetry/query`,
    {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: "Bearer " + io.credentials.CLOUDFLARE_API_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        queryId: "adhoc",
        dry: true,
        view: "events",
        limit,
        timeframe: { from: filter.from, to: filter.to },
        parameters: {
          filters: [
            { key: "$metadata.service", value: filter.service },
            { key: filter.key, value: filter.value },
          ].map((f) => ({ ...f, type: "string", operation: "eq" })),
        },
      }),
    },
  );
  assert(response.ok, "Workers Logs query failed");
  const result = z
    .object({
      success: z.literal(true),
      result: z.object({
        events: z.object({
          events: z.array(
            z.object({
              timestamp: z.number(),
              source: z.union([z.string(), sourceSchema]),
              $workers: z.unknown(),
            }),
          ),
        }),
      }),
    })
    .parse(await response.json());
  const events = result.result.events.events;
  assert(events.length < limit, "Workers Logs query truncated");
  return events
    .flatMap((e) =>
      typeof e.source === "string"
        ? []
        : [
            {
              ...e.source,
              at: e.timestamp,
              version: z
                .object({ scriptVersion: z.object({ id: z.string().min(1) }) })
                .parse(e.$workers).scriptVersion.id,
            },
          ],
    )
    .sort((a, b) => a.at - b.at);
}
