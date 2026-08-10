CREATE TABLE tf_feishu_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_feishu_events_created_at ON tf_feishu_events(created_at);
