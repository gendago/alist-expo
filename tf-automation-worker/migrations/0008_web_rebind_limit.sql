ALTER TABLE tf_bindings
  ADD COLUMN rebind_count INTEGER NOT NULL DEFAULT 0
  CHECK (rebind_count >= 0 AND rebind_count <= 2);

CREATE TABLE tf_web_rebind_operations (
  id TEXT PRIMARY KEY,
  app_key TEXT NOT NULL CHECK (app_key = 'alist'),
  binding_id INTEGER NOT NULL,
  app_transaction_id_hmac TEXT NOT NULL,
  from_email_hmac TEXT NOT NULL,
  target_email_hmac TEXT NOT NULL,
  target_email_ciphertext TEXT NOT NULL,
  old_tester_id TEXT,
  new_tester_id TEXT,
  expected_rebind_count INTEGER NOT NULL CHECK (
    expected_rebind_count >= 0 AND expected_rebind_count < 2
  ),
  stage TEXT NOT NULL CHECK (stage IN (
    'prepared', 'old_removing', 'old_removed', 'new_adding',
    'new_invited', 'completed', 'cancelled'
  )),
  asc_stage TEXT NOT NULL DEFAULT 'none',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (binding_id) REFERENCES tf_bindings(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_web_rebind_active_binding
  ON tf_web_rebind_operations(app_key, binding_id)
  WHERE stage NOT IN ('completed', 'cancelled');

CREATE UNIQUE INDEX idx_web_rebind_active_target
  ON tf_web_rebind_operations(app_key, target_email_hmac)
  WHERE stage NOT IN ('completed', 'cancelled');

CREATE INDEX idx_web_rebind_recovery
  ON tf_web_rebind_operations(stage, next_attempt_at, updated_at);
