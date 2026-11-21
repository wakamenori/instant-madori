CREATE TABLE stg_claude_permission_request AS
SELECT natural_key AS id, payload->>'$.at' AS requested_at,
       payload->>'$.input.session_id' AS session_id, payload->>'$.input.prompt_id' AS prompt_id,
       payload->>'$.input.tool_name' AS tool_name, payload->>'$.input.cwd' AS cwd,
       payload->>'$.env.T3CODE_THREAD_ID' AS thread_id
FROM staging_record WHERE source='claude.hook' AND valid_to IS NULL
  AND payload->>'$.input.hook_event_name'='PermissionRequest';

CREATE VIEW stg_t3_approval_history AS
SELECT natural_key AS id, payload->>'$.thread_id' AS thread_id,
       payload->>'$.provider_turn_id' AS provider_turn_id, payload->>'$.kind' AS kind,
       payload->>'$.status' AS status, payload->>'$.decision' AS decision,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload->>'$.created_at') AS requested_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload->>'$.resolved_at') AS resolved_at, valid_from, valid_to
FROM staging_record WHERE source='t3.approval';

CREATE TABLE stg_t3_approval AS SELECT * FROM stg_t3_approval_history WHERE valid_to IS NULL;

CREATE TABLE stg_claude_tool_decision AS
SELECT r.natural_key AS id, r.occurred_at AS decided_at,
       max(CASE a.value->>'$.key' WHEN 'session.id' THEN a.value->>'$.value.stringValue' END) AS session_id,
       max(CASE a.value->>'$.key' WHEN 'prompt.id' THEN a.value->>'$.value.stringValue' END) AS prompt_id,
       max(CASE a.value->>'$.key' WHEN 'tool_use_id' THEN a.value->>'$.value.stringValue' END) AS tool_use_id,
       max(CASE a.value->>'$.key' WHEN 'tool_name' THEN a.value->>'$.value.stringValue' END) AS tool_name,
       max(CASE a.value->>'$.key' WHEN 'decision' THEN a.value->>'$.value.stringValue' END) AS decision
FROM raw.l1_record r, json_each(r.payload,'$.log_record.attributes') a
WHERE r.source='claude.otel.log' AND a.type='object'
GROUP BY r.ingest_id
HAVING max(CASE a.value->>'$.key' WHEN 'event.name' THEN a.value->>'$.value.stringValue' END)='tool_decision';
