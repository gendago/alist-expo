PRAGMA foreign_keys = ON;

CREATE TABLE tf_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_key TEXT NOT NULL CHECK (app_key = 'alist'),
  app_transaction_id_hmac TEXT NOT NULL,
  email_hmac TEXT NOT NULL,
  email_ciphertext TEXT NOT NULL,
  asc_tester_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_asc', 'active', 'revoked', 'manual_required')),
  asc_stage TEXT NOT NULL DEFAULT 'none',
  revoked_at INTEGER,
  revocation_evidence_hmac TEXT,
  asc_removal_state TEXT NOT NULL DEFAULT 'not_requested',
  asc_removal_last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (app_key, app_transaction_id_hmac),
  UNIQUE (app_key, email_hmac)
);

CREATE TABLE tf_claim_sessions (
  id_hmac TEXT PRIMARY KEY,
  app_key TEXT NOT NULL CHECK (app_key = 'alist'),
  app_transaction_id_hmac TEXT NOT NULL,
  created_ip_hmac TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('issued', 'applying', 'bound_pending_asc', 'completed', 'expired', 'failed_retryable')),
  email_hmac TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_claim_transaction_state
  ON tf_claim_sessions(app_key, app_transaction_id_hmac, state, expires_at);
CREATE INDEX idx_claim_expiry ON tf_claim_sessions(expires_at);

CREATE TABLE tf_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  app_key TEXT NOT NULL CHECK (app_key = 'alist'),
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  subject_hmac TEXT,
  ip_hmac TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_attempts_created_at ON tf_attempts(created_at);

CREATE TABLE tf_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  app_key TEXT NOT NULL CHECK (app_key = 'alist'),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_hmac TEXT,
  result TEXT NOT NULL,
  details_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created_at ON tf_audit_log(created_at);

CREATE TABLE tf_cooldowns (
  scope_hmac TEXT PRIMARY KEY,
  blocked_until INTEGER NOT NULL,
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tf_operation_leases (
  resource_hmac TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
