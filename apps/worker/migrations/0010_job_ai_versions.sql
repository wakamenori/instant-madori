ALTER TABLE jobs ADD COLUMN ai_model TEXT;
ALTER TABLE jobs ADD COLUMN ai_prompt_version TEXT;
ALTER TABLE jobs ADD COLUMN ai_tool_schema_version TEXT CHECK (
  (ai_model IS NULL) = (ai_prompt_version IS NULL)
  AND (ai_model IS NULL) = (ai_tool_schema_version IS NULL)
);
