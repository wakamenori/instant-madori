CREATE TABLE mart_turn_detail AS
WITH calls(session,kind,detail,start,end) AS (
 SELECT session,'model',NULL,start,end FROM stg_model_call
 UNION ALL SELECT session,'tool',name,start,end FROM stg_tool_call
)
SELECT a.issue,a.id actor,c.kind,c.detail,c.start,c.end
FROM calls c JOIN stg_session_thread s USING(session) JOIN actor a ON a.id=s.thread_id
UNION ALL SELECT a.issue,a.id,'approval',v.kind,v.requested_at,v.resolved_at
FROM stg_t3_approval v JOIN actor a ON a.id=v.thread_id
UNION ALL SELECT issue,detail,'docker_slot',actor,start,end FROM span WHERE kind='docker_wait';
