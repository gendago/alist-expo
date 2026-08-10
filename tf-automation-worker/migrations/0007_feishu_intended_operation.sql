ALTER TABLE tf_feishu_rebind_jobs
  ADD COLUMN intended_operation TEXT
    CHECK (
      intended_operation IS NULL
      OR intended_operation IN ('initial_binding', 'rebind', 'repair')
    );
