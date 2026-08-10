ALTER TABLE tf_feishu_rebind_jobs
  ADD COLUMN card_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tf_feishu_rebind_jobs
  ADD COLUMN card_failed_terminal INTEGER NOT NULL DEFAULT 0
    CHECK (card_failed_terminal IN (0, 1));

CREATE INDEX idx_feishu_rebind_jobs_card_recovery
  ON tf_feishu_rebind_jobs(card_status, card_failed_terminal, next_attempt_at);
