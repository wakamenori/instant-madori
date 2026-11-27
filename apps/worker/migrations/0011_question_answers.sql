ALTER TABLE messages ADD COLUMN pattern_message TEXT GENERATED ALWAYS AS (pattern_id || '/' || id) VIRTUAL;
CREATE UNIQUE INDEX messages_pattern_message ON messages (pattern_message);
ALTER TABLE messages ADD COLUMN question_id TEXT
  CONSTRAINT messages_answer_question CHECK ((kind = 'answer') = (question_id IS NOT NULL));
ALTER TABLE messages ADD COLUMN pattern_question TEXT
  GENERATED ALWAYS AS (pattern_id || '/' || question_id) VIRTUAL REFERENCES messages (pattern_message);
-- The turn of the input whose job asked. Instructions take their own number as their turn.
ALTER TABLE messages ADD COLUMN answer_turn INTEGER
  CONSTRAINT messages_answer_turn CHECK ((kind = 'answer') = (answer_turn IS NOT NULL) AND (answer_turn IS NULL OR answer_turn >= 1));
ALTER TABLE messages ADD COLUMN turn INTEGER GENERATED ALWAYS AS (coalesce(answer_turn, number)) VIRTUAL;
CREATE UNIQUE INDEX messages_one_answer_per_question ON messages (question_id) WHERE question_id IS NOT NULL;
CREATE UNIQUE INDEX messages_one_question_per_job ON messages (job_id) WHERE kind = 'question';
CREATE INDEX messages_inputs_by_turn ON messages (pattern_id, turn, number) WHERE kind IN ('instruction', 'answer');
