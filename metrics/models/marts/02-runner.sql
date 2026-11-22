CREATE TABLE mart_ci_job AS
SELECT CAST(id AS INTEGER) job_id,run_id,workflow,created_at,started_at,completed_at,runner_name,conclusion,
 (julianday(started_at)-julianday(created_at))*1440 queue_minutes,
 (julianday(completed_at)-julianday(started_at))*1440 run_minutes,
 CASE WHEN workflow='check' THEN iif(EXISTS(SELECT 1 FROM json_each(steps)
 WHERE value->>'$.name' LIKE '%pnpm check%--full%'),'full','default') END mode,
 (SELECT json_group_array(json_object('name',value->>'$.name','minutes',
  (julianday(value->>'$.completed_at')-julianday(value->>'$.started_at'))*1440)) FROM json_each(steps)) steps,
 '1' definition_version FROM measured_actions_job;
CREATE TABLE mart_runner_hour AS
WITH RECURSIVE hours(t,last) AS (
 SELECT unixepoch(min(started_at))/3600*3600,unixepoch(max(completed_at)) FROM mart_ci_job
 UNION ALL SELECT t+3600,last FROM hours WHERE t+3600<last
), occupancy AS (
 SELECT t,workflow,sum((min(t+3600,unixepoch(completed_at))-max(t,unixepoch(started_at)))/60.0) minutes
 FROM hours JOIN mart_ci_job ON unixepoch(started_at)<t+3600 AND unixepoch(completed_at)>t GROUP BY t,workflow
)
SELECT strftime('%Y-%m-%dT%H:%M:%fZ',h.t,'unixepoch') hour,coalesce(sum(minutes) FILTER(WHERE workflow='check'),0) check_minutes,
 coalesce(sum(minutes) FILTER(WHERE workflow='deploy-staging'),0) deploy_minutes,coalesce(sum(minutes),0)/60 utilization,'1' definition_version
FROM hours h LEFT JOIN occupancy o USING(t) WHERE h.t IS NOT NULL GROUP BY h.t;
