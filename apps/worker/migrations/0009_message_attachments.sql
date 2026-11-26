CREATE TABLE message_attachments (
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  pattern_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  PRIMARY KEY (message_id, position),
  UNIQUE (message_id, asset_id),
  FOREIGN KEY (message_id, pattern_id) REFERENCES messages (id, pattern_id),
  FOREIGN KEY (pattern_id, owner_id) REFERENCES patterns (id, owner_id),
  FOREIGN KEY (asset_id, owner_id) REFERENCES assets (id, owner_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX message_attachments_by_asset ON message_attachments (asset_id, owner_id);
