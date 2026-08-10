ALTER TABLE tf_feishu_rebind_jobs
  ADD COLUMN card_lease_owner TEXT;
ALTER TABLE tf_feishu_rebind_jobs
  ADD COLUMN card_lease_expires_at INTEGER;

CREATE INDEX idx_feishu_rebind_jobs_card_lease
  ON tf_feishu_rebind_jobs(
    card_status,
    card_failed_terminal,
    card_lease_expires_at,
    next_attempt_at
  );
