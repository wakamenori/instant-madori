CREATE VIEW stg_t3_thread_history AS
SELECT natural_key AS id,
       payload ->> '$.project_match' AS project_match,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.created_at') AS created_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.settled_at') AS settled_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.archived_at') AS archived_at,
       payload ->> '$.provider' AS provider,
       payload ->> '$.model' AS model,
       payload ->> '$.effort' AS effort,
       payload ->> '$.creation_source' AS creation_source,
       payload ->> '$.relationship_to_parent' AS relationship_to_parent,
       payload ->> '$.parent_thread_id' AS parent_thread_id,
       payload ->> '$.root_thread_id' AS root_thread_id,
       payload ->> '$.worktree_path' AS worktree_path,
       payload ->> '$.branch' AS branch,
       payload ->> '$.pr_numbers' AS pr_numbers,
       payload ->> '$.title_kind' AS title_kind,
       payload ->> '$.issue' AS issue,
       payload ->> '$.pr' AS pr,
       payload ->> '$.sha' AS sha,
       valid_from,
       valid_to
FROM staging_record WHERE source='t3.thread';

CREATE TABLE stg_t3_thread AS SELECT * FROM stg_t3_thread_history WHERE valid_to IS NULL;
