CREATE VIEW stg_classification_backfill AS
SELECT payload->>'$.issue' issue,payload->>'$.kind' kind,
       payload->>'$.found_at' found_at,payload->>'$.found_by' found_by,
       payload->>'$.cause' cause,payload->>'$.plan_change' plan_change
FROM staging_record WHERE source='classification.backfill' AND valid_to IS NULL;
