CREATE TABLE mart_turn_detail AS
WITH calls AS (
 SELECT r.ingest_id,r.occurred_at end,
 max(iif(a.value->>'$.key' IN ('session.id','conversation.id'),a.value->>'$.value.stringValue',NULL)) session,
 max(iif(a.value->>'$.key'='event.name',a.value->>'$.value.stringValue',NULL)) event,
 max(iif(a.value->>'$.key'='tool_name',a.value->>'$.value.stringValue',NULL)) tool,
 max(iif(a.value->>'$.key'='duration_ms',coalesce(a.value->>'$.value.intValue',a.value->>'$.value.doubleValue',a.value->>'$.value.stringValue'),NULL)) duration
 FROM raw.l1_record r,json_each(r.payload,'$.log_record.attributes') a WHERE r.source IN ('claude.otel.log','codex.otel.log') GROUP BY r.ingest_id
), sessions AS (
 SELECT DISTINCT payload->>'$.input.session_id' session,payload->>'$.env.T3CODE_THREAD_ID' thread_id
 FROM stg_claude_hook
 UNION SELECT payload->>'$.conversation_id',payload->>'$.thread_id' FROM stg_t3_codex_link
), docker AS (
 SELECT wait_id,cwd,run_id,run_attempt,min(at) FILTER(WHERE phase='started') start,
 min(at) FILTER(WHERE phase IN ('acquired','cancelled')) end FROM stg_docker_slot GROUP BY wait_id
)
SELECT a.issue,a.id actor,iif(event='api_request','model','tool') kind,tool detail,
 strftime('%Y-%m-%dT%H:%M:%fZ',julianday(c.end)-duration/86400000.0) start,c.end
FROM calls c JOIN sessions s USING(session) JOIN actor a ON a.id=s.thread_id
WHERE event IN ('api_request','tool_result','codex.tool_result') AND duration IS NOT NULL
UNION ALL SELECT a.issue,a.id,'approval',v.kind,v.requested_at,v.resolved_at
FROM stg_t3_approval v JOIN actor a ON a.id=v.thread_id
UNION ALL SELECT DISTINCT coalesce(a.issue,ij.issue),a.id,'docker_slot',d.wait_id,d.start,d.end
FROM docker d LEFT JOIN stg_t3_thread t ON d.cwd=t.worktree_path OR substr(d.cwd,1,length(t.worktree_path)+1)=t.worktree_path||'/'
LEFT JOIN actor a ON a.id=t.id LEFT JOIN stg_actions_job j ON j.run_id=d.run_id AND j.run_attempt=d.run_attempt
LEFT JOIN issue_job ij ON ij.id=j.id WHERE d.start IS NOT NULL;
