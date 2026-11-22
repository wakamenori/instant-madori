CREATE VIEW effort_scope AS SELECT '2026-11-21T12:21:00.000Z' start;
CREATE TABLE effort_frame AS
SELECT issue,id owner,max(start,(SELECT start FROM effort_scope)) start,end FROM owner_interval
WHERE end>(SELECT start FROM effort_scope) AND start<end;
CREATE INDEX effort_frame_issue ON effort_frame(issue,start);

CREATE TABLE verified_head AS
SELECT d.issue,d.pr,d.head,d.verdict,strftime('%Y-%m-%dT%H:%M:%fZ',d.at) verdict_at,min(strftime('%Y-%m-%dT%H:%M:%fZ',d.at),coalesce(
 (SELECT min(a.created_at) FROM stg_actions_attempt a WHERE a.workflow='check' AND a.run_attempt=1
  AND (a.head_sha=d.head OR (length(d.head)>=7 AND a.head_sha LIKE d.head||'%'))),
 (SELECT created_at FROM actor WHERE id=d.actor),strftime('%Y-%m-%dT%H:%M:%fZ',d.at))) pushed
FROM verification_decision d WHERE d.verdict IN ('PASS','FAIL');

CREATE TABLE issue_phase AS
WITH marks(issue,at,phase,tie) AS (
 SELECT issue,min(created_at),'implementation',0 FROM owner WHERE issue IS NOT NULL GROUP BY issue
 UNION ALL SELECT issue,pushed,'verification',1 FROM verified_head
 UNION ALL SELECT issue,verdict_at,iif(verdict='PASS','merge_wait','rework'),2 FROM verified_head
 UNION ALL SELECT issue,merged_at,'post_merge',3 FROM issue_classification WHERE merged_at IS NOT NULL AND ownership='owner'
), live AS (
 SELECT m.* FROM marks m LEFT JOIN issue_classification c USING(issue)
 WHERE c.merged_at IS NULL OR m.at<c.merged_at OR m.phase='post_merge'
)
SELECT issue,phase,at start,tie,lead(at) OVER(PARTITION BY issue ORDER BY at,tie) end FROM live;
CREATE INDEX issue_phase_issue ON issue_phase(issue,start,tie);

CREATE TABLE approval_wait AS
SELECT a.issue,a.id actor,v.requested_at start,
 min(i.end,coalesce(v.resolved_at,(SELECT min(iif(s.start<=v.requested_at,s.end,s.start)) FROM span s
  WHERE s.actor=a.id AND s.kind IN ('owner_turn','verifier_run') AND coalesce(s.end,'9999')>v.requested_at),'9999')) end
FROM stg_t3_approval v JOIN actor a ON a.id=v.thread_id
JOIN owner_interval i ON i.issue=a.issue AND i.start<=a.created_at AND i.end>a.created_at
WHERE a.role IN ('owner','verifier') AND v.requested_at>=i.start AND v.requested_at<i.end;

CREATE TABLE coordinator_wait AS
SELECT h.issue,h.at start,
 (SELECT min(t) FROM (
   SELECT n.at t FROM event n WHERE n.issue=h.issue AND n.kind IN ('coordinator_message','launch','merged') AND n.at>h.at
   UNION ALL SELECT v.created_at FROM actor v WHERE v.issue=h.issue AND v.role='verifier' AND v.created_at>h.at)) end,
 CASE WHEN h.kind='report' THEN 'report' WHEN h.attributes->>'$.verdict'='PASS' THEN 'pass' ELSE 'fail' END detail
FROM event h WHERE h.kind IN ('report','verdict');
