CREATE TABLE stg_otel_event AS
WITH attrs AS (
 SELECT r.ingest_id,r.source,r.occurred_at,a.value->>'$.key' k,
  coalesce(a.value->>'$.value.stringValue',a.value->>'$.value.intValue',a.value->>'$.value.doubleValue') v
 FROM staging_record r LEFT JOIN json_each(r.payload,'$.log_record.attributes') a
 WHERE r.source IN ('claude.otel.log','codex.otel.log') AND r.valid_to IS NULL
)
SELECT ingest_id,iif(source='claude.otel.log','claude','codex') provider,
 max(iif(k='event.name',v,NULL)) event,
 strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(max(iif(k='event.timestamp',v,NULL)),occurred_at)) at,
 -- Codex records carry both ids; conversation.id is the one t3.codex_link names.
 coalesce(max(iif(k='conversation.id',v,NULL)),max(iif(k='session.id',v,NULL))) session,
 max(iif(k='event.kind',v,NULL)) sse_kind,
 max(iif(k='tool_name',v,NULL)) tool,
 CAST(CASE WHEN max(iif(k='event.name',v,NULL))='hook_execution_complete' THEN max(iif(k='total_duration_ms',v,NULL))
  ELSE max(iif(k='duration_ms',v,NULL)) END AS REAL) duration_ms,
 max(iif(k IN ('tool_parameters','arguments'),v,NULL)) parameters
FROM attrs GROUP BY ingest_id;
CREATE INDEX otel_event_session ON stg_otel_event(provider,session,at);

CREATE TABLE stg_model_call AS
WITH codex AS (
 SELECT session,at,event,sse_kind,
  lead(at) OVER w next_at,lead(event) OVER w next_event,lead(sse_kind) OVER w next_kind
 FROM stg_otel_event
 WHERE provider='codex' AND session IS NOT NULL
 WINDOW w AS (PARTITION BY session ORDER BY at,ingest_id)
)
SELECT 'claude' provider,session,strftime('%Y-%m-%dT%H:%M:%fZ',julianday(at)-duration_ms/86400000.0) start,at end
FROM stg_otel_event WHERE provider='claude' AND event='api_request' AND duration_ms IS NOT NULL
UNION ALL SELECT 'codex',session,at,next_at FROM codex
WHERE event='codex.websocket_request' AND next_event='codex.sse_event' AND next_kind='response.completed';

CREATE TABLE tool_mark(provider TEXT,name TEXT,mark TEXT NOT NULL CHECK(mark IN ('wait','decision','wrapper')),stands_for TEXT CHECK(stands_for='local_run'),PRIMARY KEY(provider,name));
INSERT INTO tool_mark VALUES
 ('claude','Agent','wait',NULL),('claude','Task','wait',NULL),
 ('claude','t3-code/t3_background_wait','wait',NULL),('claude','t3-code/t3_thread_wait','wait',NULL),
 ('codex','wait','wait','local_run'),('codex','write_stdin','wait','local_run'),('codex','exec','wrapper',NULL),('codex','sleep','wait',NULL),
 ('codex','t3_background_wait','wait',NULL),('codex','t3_thread_wait','wait',NULL),
 ('claude','AskUserQuestion','decision',NULL),('claude','t3-code/request_secret','decision',NULL),
 ('codex','request_user_input','decision',NULL),('codex','request_secret','decision',NULL);
CREATE TABLE wait_command(pattern TEXT PRIMARY KEY);
INSERT INTO wait_command VALUES ('*until *do*sleep [0-9]*done*'),('*while *do*sleep [0-9]*done*'),
 ('*for *do*sleep [0-9]*done*'),(' sleep [0-9]*'),('*--watch*'),('*gh run watch*');

CREATE TABLE stg_tool_call AS
WITH calls AS (
 SELECT provider,session,
  CASE WHEN event='hook_execution_complete' THEN 'hook'
   WHEN tool='mcp_tool' AND json_valid(parameters) THEN (parameters->>'$.mcp_server_name')||'/'||(parameters->>'$.mcp_tool_name')
   ELSE tool END name,
  CASE WHEN json_valid(parameters) THEN coalesce(parameters->>'$.full_command',parameters->>'$.cmd') END command,
  strftime('%Y-%m-%dT%H:%M:%fZ',julianday(at)-duration_ms/86400000.0) start,at end
 FROM stg_otel_event
 WHERE event IN ('tool_result','codex.tool_result','hook_execution_complete') AND duration_ms IS NOT NULL
)
SELECT c.*,coalesce(m.mark,
 iif(EXISTS(SELECT 1 FROM wait_command w WHERE ' '||c.command||' ' GLOB w.pattern),'wait',NULL)) mark,m.stands_for
FROM calls c LEFT JOIN tool_mark m USING(provider,name);

CREATE TABLE stg_session_thread AS
SELECT DISTINCT payload->>'$.input.session_id' session,payload->>'$.env.T3CODE_THREAD_ID' thread_id
FROM stg_claude_hook WHERE payload->>'$.env.T3CODE_THREAD_ID' IS NOT NULL
UNION SELECT payload->>'$.conversation_id',payload->>'$.thread_id' FROM stg_t3_codex_link;
