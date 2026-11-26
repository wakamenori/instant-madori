import { reserveAiAttempt, settleAiAttempt } from "./ai-cost.ts";
import type { D1 } from "./d1.ts";
import type { R2 } from "./r2.ts";
import * as assets from "./assets.ts";
import * as projects from "./projects.ts";
import * as patterns from "./patterns.ts";
import * as messages from "./messages.ts";
import * as revisions from "./revisions.ts";
import * as snapshots from "./snapshots.ts";
import * as jobs from "./jobs.ts";
import * as queue from "./job-queue.ts";
import { jobWork } from "./job-work.ts";
import * as execution from "./job-execution.ts";
import { upsertAccessUser } from "./users.ts";

export function createStore(db: D1, bucket: R2) {
  return {
    work: jobWork(bucket),
    aiCost: {
      reserve: (
        right: Parameters<typeof reserveAiAttempt>[1],
        input: Parameters<typeof reserveAiAttempt>[2],
      ) => reserveAiAttempt(db, right, input),
      settle: (
        job: Parameters<typeof settleAiAttempt>[1],
        input: Parameters<typeof settleAiAttempt>[2],
      ) => settleAiAttempt(db, job, input),
    },
    assets: {
      open: (scope: Parameters<typeof assets.openOwnedAsset>[2]) =>
        assets.openOwnedAsset(db, bucket, scope),
      createOnce: (key: Parameters<typeof assets.createAssetOnce>[2], asset: assets.NewAsset) =>
        assets.createAssetOnce(db, bucket, key, asset),
    },
    users: {
      upsertAccess: (input: Parameters<typeof upsertAccessUser>[1]) => upsertAccessUser(db, input),
    },
    queue: {
      resumeOnce: (
        key: Parameters<typeof queue.resumeQueueOnce>[1],
        input: Parameters<typeof queue.resumeQueueOnce>[2],
      ) => queue.resumeQueueOnce(db, key, input),
      cancelOnce: (
        key: Parameters<typeof queue.cancelQueueOnce>[1],
        input: Parameters<typeof queue.cancelQueueOnce>[2],
      ) => queue.cancelQueueOnce(db, key, input),
    },
    jobs: {
      stalledPatterns: (input: Parameters<typeof queue.readStalledPatterns>[1]) =>
        queue.readStalledPatterns(db, input),
      holdingJob: (patternId: string) => queue.readHoldingJob(db, patternId),
      ownedBySubject: (right: Parameters<typeof jobs.isJobOwnedBySubject>[1], subject: string) =>
        jobs.isJobOwnedBySubject(db, right, subject),
      stopOnce: (
        key: Parameters<typeof jobs.stopJobOnce>[1],
        input: Parameters<typeof jobs.stopJobOnce>[2],
      ) => jobs.stopJobOnce(db, key, input),
      claim: (input: Parameters<typeof execution.claimNextJob>[1]) =>
        execution.claimNextJob(db, input),
      restore: (reference: Parameters<typeof execution.readCurrentJobExecution>[1]) =>
        execution.readCurrentJobExecution(db, reference),
      activeJob: (input: Parameters<typeof execution.readActiveJob>[1]) =>
        execution.readActiveJob(db, input),
      check: (right: Parameters<typeof jobs.checkJobExecution>[1]) =>
        jobs.checkJobExecution(db, right),
      complete: (
        right: Parameters<typeof jobs.completeJob>[2],
        input: Parameters<typeof jobs.completeJob>[3],
      ) => jobs.completeJob(db, bucket, right, input),
      failAndHoldQueue: (right: Parameters<typeof jobs.failJobAndHoldQueue>[1], now: string) =>
        jobs.failJobAndHoldQueue(db, right, now),
      acceptOnce: (
        key: Parameters<typeof jobs.acceptInstructionOnce>[1],
        input: Parameters<typeof jobs.acceptInstructionOnce>[2],
      ) => jobs.acceptInstructionOnce(db, key, input),
    },
    projects: {
      list: (query: Parameters<typeof projects.listProjects>[1]) =>
        projects.listProjects(db, query),
      get: (scope: Parameters<typeof projects.getProject>[1]) => projects.getProject(db, scope),
      createOnce: (
        key: Parameters<typeof projects.createProjectOnce>[1],
        input: Parameters<typeof projects.createProjectOnce>[2],
      ) => projects.createProjectOnce(db, key, input),
      renameOnce: (
        key: Parameters<typeof projects.renameProjectOnce>[1],
        input: Parameters<typeof projects.renameProjectOnce>[2],
      ) => projects.renameProjectOnce(db, key, input),
    },
    patterns: {
      list: (scope: Parameters<typeof patterns.listProjectPatterns>[1]) =>
        patterns.listProjectPatterns(db, scope),
      get: (scope: Parameters<typeof patterns.getPattern>[1]) => patterns.getPattern(db, scope),
      createOnce: (
        key: Parameters<typeof patterns.createPatternOnce>[1],
        input: Parameters<typeof patterns.createPatternOnce>[2],
      ) => patterns.createPatternOnce(db, key, input),
      renameOnce: (
        key: Parameters<typeof patterns.renamePatternOnce>[1],
        input: Parameters<typeof patterns.renamePatternOnce>[2],
      ) => patterns.renamePatternOnce(db, key, input),
    },
    messages: {
      list: (query: Parameters<typeof messages.listMessages>[1]) =>
        messages.listMessages(db, query),
    },
    revisions: {
      state: (scope: Parameters<typeof revisions.getPatternState>[1]) =>
        revisions.getPatternState(db, scope),
      list: (query: Parameters<typeof revisions.listRevisions>[1]) =>
        revisions.listRevisions(db, query),
      snapshot: (scope: Parameters<typeof revisions.getRevisionSnapshot>[1]) =>
        revisions.getRevisionSnapshot(db, scope),
    },
    snapshots: {
      write: (
        right: Parameters<typeof snapshots.writeSnapshot>[1],
        input: Parameters<typeof snapshots.writeSnapshot>[2],
      ) => snapshots.writeSnapshot(bucket, right, input),
      open: (snapshot: Parameters<typeof snapshots.openSnapshot>[1]) =>
        snapshots.openSnapshot(bucket, snapshot),
    },
  };
}

export type Store = ReturnType<typeof createStore>;
