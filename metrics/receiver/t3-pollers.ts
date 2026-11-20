import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { candidate, messageVerdict, threadTitle } from "../ingest/polled.ts";
import type { Poller } from "./poller.ts";

const threads = "orchestration_v2_projection_threads";
const queries = {
  "t3.thread": {
    table: "threads",
    cursor: "r.updated_at >= ?",
    id: "thread_id",
    fields: `r.created_at, r.archived_at, r.default_provider provider, r.title,
      r.payload_json ->> '$.settledAt' settled_at, r.payload_json ->> '$.creationSource' creation_source,
      r.payload_json ->> '$.lineage.relationshipToParent' relationship_to_parent,
      r.payload_json ->> '$.lineage.parentThreadId' parent_thread_id, r.payload_json ->> '$.lineage.rootThreadId' root_thread_id,
      r.payload_json ->> '$.modelSelection.model' model, coalesce(r.payload_json ->> '$.modelSelection.options.effort',
      (select value ->> '$.value' from json_each(r.payload_json,'$.modelSelection.options') where type='object' and value ->> '$.id'='effort')) effort,
      r.payload_json ->> '$.worktreePath' worktree_path, r.payload_json ->> '$.branch' branch,
      (select json_group_array(value ->> '$.number') from json_each(r.payload_json,'$.pullRequests')) prs`,
  },
  "t3.run": {
    table: "runs",
    cursor: "(r.completed_at is null or r.completed_at >= ?)",
    id: "run_id",
    fields: `r.thread_id,r.ordinal,r.status,r.requested_at,r.completed_at,r.payload_json ->> '$.startedAt' started_at,r.payload_json ->> '$.userMessageId' user_message_id`,
  },
  "t3.message": {
    table: "messages",
    cursor: "r.updated_at >= ? and r.streaming=0 and r.role in ('user','assistant')",
    id: "message_id",
    fields: `r.thread_id,r.role,r.created_at,t.title,r.payload_json ->> '$.createdBy' created_by,
    r.payload_json ->> '$.creationSource' creation_source,r.payload_json ->> '$.senderThreadId' sender_thread_id,
    coalesce((r.payload_json ->> '$.notification.source.kind') || coalesce(':' || (r.payload_json ->> '$.notification.source.work'),''),case when json_type(r.payload_json,'$.delegatedCompletion')='object' then 'delegated_completion' end) notification_kind,
    r.payload_json ->> '$.notification.outcome' notification_outcome,
    length(coalesce(r.payload_json ->> '$.text','')) text_length,
    case when t.title like '検証 #%' and r.role='assistant' then substr(r.payload_json ->> '$.text',1,400) end head`,
  },
  "t3.subagent": {
    table: "subagents",
    cursor: "r.updated_at >= ?",
    id: "subagent_id",
    fields:
      "r.thread_id,r.child_thread_id,r.provider,r.origin,r.status,r.started_at,r.completed_at",
  },
} as const;
const scalarRow = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
export function t3Pollers(file: string, root: string, home: string): Poller[] {
  return (Object.keys(queries) as (keyof typeof queries)[]).map((name) => {
    const query = queries[name];
    let since = "",
      next = "";
    const checkpoint = join(home, name + ".cursor");
    try {
      since = z.iso.datetime().parse(readFileSync(checkpoint, "utf8"));
    } catch {
      /* A missing checkpoint replays that source from its first thread. */
    }
    return {
      name,
      intervalMs: 60_000,
      committed() {
        writeFileSync(checkpoint + ".tmp", next, { mode: 0o600 });
        renameSync(checkpoint + ".tmp", checkpoint);
        since = next;
      },
      poll() {
        const db = new DatabaseSync(file, { readOnly: true, timeout: 250 });
        try {
          next = new Date(Date.now() - 60_000).toISOString();
          const sql = `select r.${query.id} id,${query.fields} from orchestration_v2_projection_${query.table} r join ${threads} t on t.thread_id=r.thread_id join projection_projects p on p.project_id=t.project_id where p.workspace_root=? and ${query.cursor}`;
          return db
            .prepare(sql)
            .all(root, since)
            .map((raw) => {
              const { id, title, prs, head, ...fields } = scalarRow.parse(raw);
              const extras =
                name === "t3.thread"
                  ? {
                      ...threadTitle(String(title)),
                      project_match: true,
                      pr_numbers: z.array(z.number()).parse(JSON.parse(String(prs))),
                    }
                  : name === "t3.message"
                    ? {
                        verdict: messageVerdict(
                          String(title),
                          String(fields.role),
                          String(head ?? ""),
                        ),
                      }
                    : {};
              return candidate(
                name,
                String(id),
                String(fields.created_at ?? fields.requested_at ?? fields.started_at ?? "") || null,
                { ...fields, ...extras },
              );
            });
        } finally {
          db.close();
        }
      },
    };
  });
}
