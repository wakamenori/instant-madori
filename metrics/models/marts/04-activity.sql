CREATE TEMP TABLE effort_input(issue,class TEXT NOT NULL CHECK(class IN ('frame','boundary',
 'generation_owner','generation_implementer','generation_verifier','generation_other',
 'local_owner','local_implementer','local_verifier','local_other','ci_run','deploy_run',
 'approval','decision','ci_queue','docker_wait','deploy_queue','coord_report','coord_pass','coord_fail',
 'coordinator_this','coordinator_busy','staging_other','deploy_other')),s INTEGER,e INTEGER);
INSERT INTO effort_input
WITH bounds AS (
 SELECT issue,min(start) start,max(end) end FROM effort_frame GROUP BY issue
), issue_spans(issue,class,start,end) AS (
 SELECT s.issue,CASE WHEN k.axis IN ('turn','context') THEN 'boundary'
  WHEN k.axis IN ('generation','local') THEN k.axis||'_'||i.role ELSE s.kind END,s.start,s.end
 FROM span s LEFT JOIN span_kind k USING(kind) LEFT JOIN inside_actor i ON i.id=s.actor AND k.axis IN ('generation','local')
 WHERE s.issue IS NOT NULL
 UNION ALL SELECT detail,'coordinator_this',start,end FROM span WHERE kind='coordinator_turn' AND detail IS NOT NULL
 UNION ALL SELECT issue,'approval',start,end FROM approval_wait
 UNION ALL SELECT issue,'coord_'||detail,start,end FROM coordinator_wait
), shared_spans(issue,class,start,end) AS (
 -- Owned by no Issue or by another Issue; they only qualify the Issue's own waits.
 SELECT NULL,'coordinator_busy',start,end FROM span WHERE kind='coordinator_turn'
 UNION ALL SELECT issue,'staging_other',start,end FROM span WHERE kind='staging_occupancy'
 UNION ALL SELECT NULL,'deploy_other',started_at,end FROM deploy_attempt WHERE started_at IS NOT NULL
), clipped AS (
 SELECT f.issue,x.class,max(x.start,f.start) s,min(coalesce(x.end,f.end),f.end) e
 FROM bounds f JOIN issue_spans x ON x.issue=f.issue AND x.start<f.end AND coalesce(x.end,'9999')>f.start
 UNION ALL SELECT f.issue,x.class,max(x.start,f.start),min(coalesce(x.end,f.end),f.end)
 FROM bounds f JOIN shared_spans x ON x.issue IS NOT f.issue AND x.start<f.end AND coalesce(x.end,'9999')>f.start
 UNION ALL SELECT issue,'frame',start,end FROM effort_frame
 UNION ALL SELECT p.issue,'boundary',p.start,p.start FROM issue_phase p JOIN effort_frame f
 ON f.issue=p.issue AND p.start>f.start AND p.start<f.end
)
SELECT issue,class,CAST(round(unixepoch(s,'subsec')*1000) AS INTEGER) s,CAST(round(unixepoch(e,'subsec')*1000) AS INTEGER) e
FROM clipped WHERE s<e OR class='boundary';

CREATE TEMP TABLE effort_level AS
WITH deltas(issue,t,class,d) AS (
 SELECT issue,s,class,iif(class='boundary',0,1) FROM effort_input
 UNION ALL SELECT issue,e,class,iif(class='boundary',0,-1) FROM effort_input
), points AS (
 SELECT issue,t,
  coalesce(sum(d) FILTER(WHERE class='frame'),0) frame,
  coalesce(sum(d) FILTER(WHERE class GLOB 'generation_*'),0) gen,
  coalesce(sum(d) FILTER(WHERE class GLOB 'local_*'),0) local,
  coalesce(sum(d) FILTER(WHERE class IN ('generation_owner','local_owner')),0) run_owner,
  coalesce(sum(d) FILTER(WHERE class IN ('generation_implementer','local_implementer')),0) run_implementer,
  coalesce(sum(d) FILTER(WHERE class IN ('generation_verifier','local_verifier')),0) run_verifier,
  coalesce(sum(d) FILTER(WHERE class IN ('generation_other','local_other')),0) run_other,
  coalesce(sum(d) FILTER(WHERE class='ci_run'),0) ci,
  coalesce(sum(d) FILTER(WHERE class='deploy_run'),0) deploy,
  coalesce(sum(d) FILTER(WHERE class='approval'),0) approval,
  coalesce(sum(d) FILTER(WHERE class='decision'),0) decision,
  coalesce(sum(d) FILTER(WHERE class='ci_queue'),0) ci_queue,
  coalesce(sum(d) FILTER(WHERE class='docker_wait'),0) docker_wait,
  coalesce(sum(d) FILTER(WHERE class='deploy_queue'),0) deploy_queue,
  coalesce(sum(d) FILTER(WHERE class='coord_report'),0) coord_report,
  coalesce(sum(d) FILTER(WHERE class='coord_pass'),0) coord_pass,
  coalesce(sum(d) FILTER(WHERE class='coord_fail'),0) coord_fail,
  coalesce(sum(d) FILTER(WHERE class='coordinator_this'),0) coordinator_this,
  coalesce(sum(d) FILTER(WHERE class='coordinator_busy'),0) coordinator_busy,
  coalesce(sum(d) FILTER(WHERE class='staging_other'),0) staging_other,
  coalesce(sum(d) FILTER(WHERE class='deploy_other'),0) deploy_other
 FROM deltas GROUP BY issue,t
)
SELECT issue,t,lead(t) OVER w next_t,
 sum(frame) OVER w frame,sum(gen) OVER w gen,sum(local) OVER w local,
 sum(run_owner) OVER w run_owner,sum(run_implementer) OVER w run_implementer,sum(run_verifier) OVER w run_verifier,sum(run_other) OVER w run_other,
 sum(ci) OVER w ci,sum(deploy) OVER w deploy,sum(approval) OVER w approval,sum(decision) OVER w decision,
 sum(ci_queue) OVER w ci_queue,sum(docker_wait) OVER w docker_wait,sum(deploy_queue) OVER w deploy_queue,
 sum(coord_report) OVER w coord_report,sum(coord_pass) OVER w coord_pass,sum(coord_fail) OVER w coord_fail,
 sum(coordinator_this) OVER w coordinator_this,sum(coordinator_busy) OVER w coordinator_busy,sum(staging_other) OVER w staging_other,sum(deploy_other) OVER w deploy_other
FROM points WINDOW w AS (PARTITION BY issue ORDER BY t);

CREATE TEMP TABLE effort_cut AS
WITH levels AS (
 SELECT l.*,next_t-t ms,gen>0 OR local>0 OR ci>0 OR deploy>0 working,
  CASE WHEN approval>0 THEN 'approval' WHEN decision>0 THEN 'decision'
   WHEN ci_queue>0 THEN 'ci_queue' WHEN docker_wait>0 THEN 'docker_wait' WHEN deploy_queue>0 THEN 'deploy_queue'
   WHEN (coord_report>0 OR coord_pass>0) AND staging_other>0 AND d.deployable IS NOT 0 THEN 'staging'
   WHEN coord_pass>0 AND deploy_other>0 AND d.deployable IS NOT 0 THEN 'deploy_order'
   WHEN coord_pass+coord_fail+coord_report>0 THEN CASE WHEN coordinator_this>0 THEN 'this_issue'
    WHEN coordinator_busy>0 THEN 'elsewhere' ELSE 'stopped' END END waiting_on
 FROM effort_level l LEFT JOIN issue_classification c USING(issue)
 LEFT JOIN deploy_scope d ON d.pr=coalesce(c.pr,(SELECT ic.pr FROM issue_change ic WHERE ic.issue=l.issue ORDER BY ic.pr LIMIT 1))
 WHERE frame>0 AND next_t>t
)
SELECT *,strftime('%Y-%m-%dT%H:%M:%fZ',t/1000.0,'unixepoch') start,strftime('%Y-%m-%dT%H:%M:%fZ',next_t/1000.0,'unixepoch') end,
 (SELECT phase FROM issue_phase p WHERE p.issue=levels.issue AND CAST(round(unixepoch(p.start,'subsec')*1000) AS INTEGER)<=levels.t
  ORDER BY p.start DESC,p.tie DESC LIMIT 1) phase,
 CASE WHEN working THEN 'work' WHEN waiting_on IS NOT NULL THEN 'wait' ELSE 'unclassified' END tier,
 CASE WHEN working OR waiting_on IS NULL THEN NULL
  WHEN waiting_on IN ('approval','decision') THEN 'human'
  WHEN waiting_on IN ('ci_queue','docker_wait','deploy_queue','staging','deploy_order') THEN 'resource'
  ELSE 'coordinator' END wait_target
FROM levels;

CREATE TABLE mart_effort_interval AS
SELECT issue,start,end,ms,phase,tier,wait_target,iif(tier='wait',waiting_on,NULL) wait_detail,
 gen*ms generation_ms,local*ms local_ms,ci*ms ci_ms,deploy*ms deploy_ms,'1' definition_version
FROM effort_cut;
CREATE UNIQUE INDEX effort_interval_issue ON mart_effort_interval(issue,start);

CREATE TABLE mart_effort_tag AS
SELECT issue,start,end,'tier:'||tier tag FROM effort_cut
UNION ALL SELECT issue,start,end,'wait:'||wait_target FROM effort_cut WHERE wait_target IS NOT NULL
UNION ALL SELECT issue,start,end,'detail:'||waiting_on FROM effort_cut WHERE tier='wait'
UNION ALL SELECT issue,start,end,'phase:'||phase FROM effort_cut WHERE phase IS NOT NULL
UNION ALL SELECT issue,start,end,'run:owner' FROM effort_cut WHERE run_owner>0
UNION ALL SELECT issue,start,end,'run:implementer' FROM effort_cut WHERE run_implementer>0
UNION ALL SELECT issue,start,end,'run:verifier' FROM effort_cut WHERE run_verifier>0
UNION ALL SELECT issue,start,end,'run:other' FROM effort_cut WHERE run_other>0
UNION ALL SELECT issue,start,end,'run:local' FROM effort_cut WHERE local>0
UNION ALL SELECT issue,start,end,'run:ci' FROM effort_cut WHERE ci>0
UNION ALL SELECT issue,start,end,'queue:ci' FROM effort_cut WHERE ci_queue>0
UNION ALL SELECT issue,start,end,'approval' FROM effort_cut WHERE approval>0
UNION ALL SELECT issue,start,end,'check_wait' FROM effort_cut WHERE phase='merge_wait' AND (ci>0 OR ci_queue>0);
CREATE INDEX effort_tag_lookup ON mart_effort_tag(issue,start,tag);

CREATE TEMP TABLE sampled_interval AS
SELECT m.*,(
 SELECT e.start FROM mart_effort_interval e WHERE e.issue=m.issue AND e.start<=m.at AND e.end>m.at
 ORDER BY e.start DESC LIMIT 1
) start FROM issue_minute m;

CREATE TABLE mart_minute AS
SELECT m.issue,m.minute,m.at,CASE WHEN e.wait_target='coordinator' THEN 'wait.coordinator.'||e.wait_detail
 WHEN e.wait_target IS NOT NULL THEN 'wait.'||e.wait_target ELSE coalesce(e.tier,'unrecorded') END state
FROM sampled_interval m LEFT JOIN mart_effort_interval e USING(issue,start);

CREATE TABLE mart_merge_wait AS
WITH passes AS (
 SELECT c.pr,c.merged_at merged,max(d.at) last_pass
 FROM change c LEFT JOIN verification_decision d ON d.pr=c.pr AND d.verdict='PASS' AND d.at<=c.merged_at
 WHERE c.merged_at IS NOT NULL GROUP BY c.pr
)
SELECT p.*,(julianday(merged)-julianday(last_pass))*1440 minutes,coalesce((
 SELECT e.wait_detail FROM mart_effort_interval e JOIN issue_change ic USING(issue)
 WHERE ic.pr=p.pr AND e.start>=p.last_pass AND e.end<=p.merged AND e.wait_target='resource'
 GROUP BY e.wait_detail ORDER BY sum(e.ms) DESC,e.wait_detail LIMIT 1
),'none') reason,'3' definition_version FROM passes p;

CREATE TABLE mart_active_minute AS
SELECT minute,count(*) owners,count(*) FILTER(WHERE kind='機能') feature_minutes
FROM issue_minute LEFT JOIN issue_classification USING(issue) GROUP BY minute;
CREATE UNIQUE INDEX active_minute ON mart_active_minute(minute);

CREATE TABLE mart_post_merge_deploy AS
SELECT c.issue,c.pr,p.merge_commit_sha,a.run_id,a.run_attempt,a.conclusion,
 a.created_at queued,a.started_at,a.end completed,
 CASE WHEN d.method IS NOT NULL THEN d.method WHEN s.deployable=0 THEN 'exempt'
 WHEN a.run_id IS NULL THEN 'missing_attempt' ELSE coalesce(a.conclusion,a.status) END delivery,
 d.delivered,d.run_id delivered_run_id,d.run_attempt delivered_attempt
FROM issue_classification c JOIN change p ON p.pr=c.pr JOIN deploy_scope s ON s.pr=c.pr
LEFT JOIN deploy_attempt a ON a.head_sha=p.merge_commit_sha LEFT JOIN deployment_delivery d ON d.pr=c.pr;
