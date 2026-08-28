-- 首次绑定尚未成功时更换邮箱属于初次申请恢复，不消耗两次正式换绑机会。
ALTER TABLE tf_web_rebind_operations
  ADD COLUMN counts_as_rebind INTEGER NOT NULL DEFAULT 1
  CHECK (counts_as_rebind IN (0, 1));
