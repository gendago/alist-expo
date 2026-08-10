ALTER TABLE tf_feishu_events
  ADD COLUMN app_transaction_id_ciphertext TEXT;
ALTER TABLE tf_feishu_events
  ADD COLUMN new_email_ciphertext TEXT;
