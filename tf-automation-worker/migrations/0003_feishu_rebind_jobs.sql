ALTER TABLE tf_feishu_events ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'
  CHECK (status IN ('pending', 'processing', 'completed', 'failed_retryable', 'failed_terminal'));
ALTER TABLE tf_feishu_events ADD COLUMN operator_hmac TEXT;
ALTER TABLE tf_feishu_events ADD COLUMN message_id TEXT;
ALTER TABLE tf_feishu_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tf_feishu_events ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tf_feishu_events ADD COLUMN lease_owner TEXT;
ALTER TABLE tf_feishu_events ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE tf_feishu_events ADD COLUMN last_error TEXT;
ALTER TABLE tf_feishu_events ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_feishu_events_recovery
  ON tf_feishu_events(event_type, status, next_attempt_at, lease_expires_at);

CREATE TABLE tf_feishu_forms (
  nonce_hmac TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  operator_hmac TEXT NOT NULL,
  message_id TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL CHECK (purpose = 'rebind'),
  status TEXT NOT NULL CHECK (status IN ('issuing', 'issued', 'consumed', 'expired')),
  consumed_event_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (source_event_id) REFERENCES tf_feishu_events(event_id)
);

CREATE INDEX idx_feishu_forms_expiry ON tf_feishu_forms(status, expires_at);

CREATE TABLE tf_feishu_rebind_jobs (
  event_id TEXT PRIMARY KEY,
  form_nonce_hmac TEXT NOT NULL,
  operator_hmac TEXT NOT NULL,
  message_id TEXT NOT NULL,
  app_transaction_id_ciphertext TEXT NOT NULL,
  new_email_ciphertext TEXT NOT NULL,
  transaction_hmac TEXT NOT NULL,
  email_hmac TEXT NOT NULL,
  operation_status TEXT NOT NULL CHECK (
    operation_status IN ('pending', 'running', 'succeeded', 'failed_retryable', 'failed_terminal')
  ),
  card_status TEXT NOT NULL CHECK (card_status IN ('pending', 'updated')),
  result_code TEXT,
  subject_hmac TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (event_id) REFERENCES tf_feishu_events(event_id),
  FOREIGN KEY (form_nonce_hmac) REFERENCES tf_feishu_forms(nonce_hmac)
);

CREATE INDEX idx_feishu_rebind_jobs_recovery
  ON tf_feishu_rebind_jobs(operation_status, card_status, next_attempt_at, lease_expires_at);
CREATE UNIQUE INDEX idx_feishu_rebind_jobs_form_nonce
  ON tf_feishu_rebind_jobs(form_nonce_hmac);
