CREATE VIEW stg_claude_otel_log AS SELECT * FROM staging_record WHERE source='claude.otel.log' AND valid_to IS NULL;
CREATE VIEW stg_claude_otel_metric AS SELECT * FROM staging_record WHERE source='claude.otel.metric' AND valid_to IS NULL;
CREATE VIEW stg_codex_otel_log AS SELECT * FROM staging_record WHERE source='codex.otel.log' AND valid_to IS NULL;
CREATE VIEW stg_codex_otel_metric AS SELECT * FROM staging_record WHERE source='codex.otel.metric' AND valid_to IS NULL;
CREATE VIEW stg_claude_hook AS SELECT * FROM staging_record WHERE source='claude.hook' AND valid_to IS NULL;
CREATE VIEW stg_otlp AS SELECT * FROM staging_record WHERE source='otlp' AND valid_to IS NULL;
CREATE VIEW stg_t3_codex_link AS SELECT * FROM staging_record WHERE source='t3.codex_link' AND valid_to IS NULL;
CREATE VIEW stg_metrics_receiver AS SELECT * FROM staging_record WHERE source='metrics.receiver' AND valid_to IS NULL;
