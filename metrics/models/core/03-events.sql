CREATE TABLE event AS
SELECT issue,'launch' kind,created_at at,NULL attributes FROM owner
UNION ALL SELECT o.issue,'report',m.created_at,NULL FROM stg_t3_message m JOIN owner o ON o.id=m.sender_thread_id
 JOIN actor a ON a.id=m.thread_id AND a.role='coordinator'
UNION ALL SELECT o.issue,'coordinator_message',m.created_at,NULL FROM stg_t3_message m JOIN owner o ON o.id=m.thread_id
 JOIN actor a ON a.id=m.sender_thread_id AND a.role='coordinator' WHERE m.role='user'
UNION ALL SELECT s.issue,'verdict',s.end,json_object('actor',s.actor,'pr',a.pr,'verdict',(
 SELECT m.verdict FROM stg_t3_message m WHERE m.thread_id=s.actor AND m.verdict IS NOT NULL ORDER BY m.created_at DESC LIMIT 1))
 FROM span s JOIN actor a ON a.id=s.actor AND a.issue IS s.issue WHERE s.kind='verifier_run' AND s.end IS NOT NULL
UNION ALL SELECT ic.issue,'pr_opened',c.created_at,json_object('pr',c.pr) FROM issue_change ic JOIN change c USING(pr)
UNION ALL SELECT ic.issue,'merged',c.merged_at,json_object('pr',c.pr) FROM issue_change ic JOIN change c USING(pr) WHERE c.merged_at IS NOT NULL
UNION ALL SELECT issue,'deployed',completed_at,json_object('pr',pr,'run_id',run_id) FROM issue_deploy
UNION ALL SELECT o.issue,'owner_wake',r.started_at,json_object('wake_kind',CASE
 WHEN m.id IS NULL THEN 'unknown' WHEN a.role='coordinator' THEN 'coord_msg'
 WHEN m.creation_source IN ('web','mobile') THEN 'human' WHEN m.notification_kind='delegated_completion' THEN 'delegate_done'
 WHEN m.notification_kind LIKE 'background_task%' THEN 'subagent_done' WHEN m.notification_kind='background_command' THEN 'bg_cmd_done'
 WHEN m.notification_kind='monitor' AND m.creation_source='server' THEN 'pr_watch' WHEN m.notification_kind='monitor' THEN 'monitor'
 ELSE coalesce(m.creation_source,'None') || ':' || coalesce(m.notification_kind,'') END,'actor',o.id)
 FROM owner o JOIN stg_t3_run r ON r.thread_id=o.id LEFT JOIN stg_t3_message m ON m.id=r.user_message_id
 LEFT JOIN actor a ON a.id=m.sender_thread_id WHERE r.started_at IS NOT NULL;
CREATE INDEX event_issue ON event(issue,kind,at);
