CREATE TABLE stg_docker_slot AS
SELECT payload->>'$.wait_id' wait_id, payload->>'$.phase' phase, payload->>'$.at' at,
       payload->>'$.pool' pool, payload->>'$.cwd' cwd, payload->>'$.run_id' run_id,
       payload->>'$.run_attempt' run_attempt
FROM staging_record WHERE source='docker.slot' AND valid_to IS NULL;
