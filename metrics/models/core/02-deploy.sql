CREATE TABLE deploy_attempt AS
SELECT a.*,CASE WHEN status='completed' THEN updated_at END end FROM stg_actions_attempt a WHERE workflow='deploy-staging';
CREATE INDEX deploy_commit ON deploy_attempt(head_sha,started_at);

CREATE TABLE deploy_scope AS
WITH paths(pr,path) AS (
 SELECT pr,filename FROM stg_github_pr_file UNION ALL
 SELECT pr,previous_filename FROM stg_github_pr_file WHERE previous_filename IS NOT NULL
)
SELECT p.number pr,CASE WHEN p.files_complete THEN EXISTS (
 SELECT 1 FROM paths f WHERE f.pr=p.number AND NOT
 (path GLOB '.claude/*' OR path GLOB '.github/ISSUE_TEMPLATE/*' OR path GLOB 'docs/*'
 OR path GLOB 'metrics/*' OR path IN ('AGENTS.md','CLAUDE.md','README.md'))
) END deployable FROM stg_github_pr p;

CREATE TABLE deployment_delivery AS
WITH RECURSIVE ancestry(head,sha) AS (
 SELECT DISTINCT head_sha,head_sha FROM deploy_attempt WHERE conclusion='success'
 UNION SELECT a.head,r.payload->>'$.parent' FROM ancestry a JOIN staging_record r
 ON r.source='github.commit' AND r.natural_key=a.sha AND r.valid_to IS NULL WHERE r.payload->>'$.parent' IS NOT NULL
), matched AS (
 SELECT c.pr,a.run_id,a.run_attempt,a.end delivered,
 iif(c.merge_commit_sha=a.head_sha,'direct','later_commit') method,
 row_number() OVER(PARTITION BY c.pr ORDER BY a.end,a.run_id,a.run_attempt) seq
 FROM change c JOIN deploy_scope scope USING(pr)
 JOIN deploy_attempt a ON a.conclusion='success' AND a.end>=c.merged_at
 JOIN ancestry ON ancestry.head=a.head_sha AND ancestry.sha=c.merge_commit_sha
 WHERE c.merge_commit_sha=a.head_sha OR scope.deployable IS NOT 0
)
SELECT pr,run_id,run_attempt,delivered,method FROM matched WHERE seq=1;
