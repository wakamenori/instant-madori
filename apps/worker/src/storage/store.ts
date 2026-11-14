import type { D1 } from "./d1.ts";
import type { R2 } from "./r2.ts";
import * as projects from "./projects.ts";
import * as patterns from "./patterns.ts";
import * as revisions from "./revisions.ts";
import * as snapshots from "./snapshots.ts";
import * as jobs from "./jobs.ts";
import { upsertAccessUser } from "./users.ts";

export function createStore(db: D1, bucket: R2) {
  return {
    users: {
      upsertAccess: (input: Parameters<typeof upsertAccessUser>[1]) => upsertAccessUser(db, input),
    },
    jobs: {
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
    revisions: {
      commit: (input: Parameters<typeof revisions.commitRevision>[1]) =>
        revisions.commitRevision(db, input),
      state: (scope: Parameters<typeof revisions.getPatternState>[1]) =>
        revisions.getPatternState(db, scope),
      list: (query: Parameters<typeof revisions.listRevisions>[1]) =>
        revisions.listRevisions(db, query),
      snapshot: (scope: Parameters<typeof revisions.getRevisionSnapshot>[1]) =>
        revisions.getRevisionSnapshot(db, scope),
    },
    snapshots: {
      write: (input: Parameters<typeof snapshots.writeSnapshot>[1]) =>
        snapshots.writeSnapshot(bucket, input),
      display: (snapshot: Parameters<typeof snapshots.readSnapshotDisplay>[1]) =>
        snapshots.readSnapshotDisplay(bucket, snapshot),
    },
  };
}

export type Store = ReturnType<typeof createStore>;
