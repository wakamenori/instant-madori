import type { AcceptedJob, PatternStateResponse, Revision } from "@madori/contracts";

const createdAt = "2026-01-01T00:00:00Z";

const idleState: PatternStateResponse = {
  pattern: {
    id: "p",
    projectId: "project",
    name: "案",
    version: 1,
    createdAt,
    updatedAt: createdAt,
  },
  currentRevision: null,
  runningJob: null,
  queuedJobs: [],
  queueHold: null,
  lastFinishedJob: null,
};

export const revision: Revision = {
  id: "revision",
  patternId: "p",
  number: 3,
  name: "窓",
  baseRevisionId: null,
  createdAt,
};

export const root: AcceptedJob = { jobId: "root", messageId: "m1", number: 1 };
export const answer: AcceptedJob = { jobId: "answer", messageId: "m5", number: 5 };
const waiting = [
  { jobId: "waiting-one", messageId: "m2", number: 2 },
  { jobId: "waiting-two", messageId: "m3", number: 3 },
];
export const question = {
  messageId: "m4",
  number: 4,
  body: "和室は必要ですか？",
  choices: ["必要", "不要"],
};
const askingJob = { ...root, state: "awaiting_answer", question, answer: null } as const;
const askingState = { ...idleState, queueHold: { job: askingJob }, queuedJobs: waiting };
const answeredState = { ...askingState, queueHold: { job: { ...askingJob, answer } } };

export const statusStates = {
  idle: idleState,
  "idle completed": { ...idleState, lastFinishedJob: { ...root, state: "completed", revision } },
  "idle closed question": { ...idleState, lastFinishedJob: { ...root, state: "awaiting_answer" } },
  "idle cancelled": { ...idleState, lastFinishedJob: { ...root, state: "cancelled" } },
  "idle failed": { ...idleState, lastFinishedJob: { ...root, state: "failed" } },
  "idle limited": { ...idleState, lastFinishedJob: { ...root, state: "limited" } },
  starting: { ...idleState, queuedJobs: waiting },
  running: { ...idleState, runningJob: root },
  "running with waiting": { ...idleState, runningJob: root, queuedJobs: waiting },
  "running inside hold": {
    ...idleState,
    runningJob: answer,
    queuedJobs: waiting,
    queueHold: { job: { ...root, state: "failed" } },
  },
  "asking without held": { ...askingState, queuedJobs: [] },
  asking: askingState,
  "answering queued": { ...answeredState, queuedJobs: [answer, ...waiting] },
  "answering running": { ...answeredState, runningJob: answer },
  "held stopped": {
    ...idleState,
    queuedJobs: waiting,
    queueHold: { job: { ...root, state: "cancelled" } },
  },
  "held failed": {
    ...idleState,
    queuedJobs: waiting,
    queueHold: { job: { ...root, state: "failed" } },
  },
  "held limited": {
    ...idleState,
    queuedJobs: waiting,
    queueHold: { job: { ...root, state: "limited" } },
  },
  "answered completed": {
    ...answeredState,
    lastFinishedJob: { ...answer, state: "completed", revision },
  },
  "answered cancelled": { ...answeredState, lastFinishedJob: { ...answer, state: "cancelled" } },
  "answered failed": { ...answeredState, lastFinishedJob: { ...answer, state: "failed" } },
  "answered limited": { ...answeredState, lastFinishedJob: { ...answer, state: "limited" } },
  "answered unknown": { ...answeredState, lastFinishedJob: { ...root, state: "awaiting_answer" } },
} satisfies Record<string, PatternStateResponse>;
