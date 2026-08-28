-- 将迁移前已经 active、但分组快照仍为旧组的绑定安全迁移到“已购用户”。
-- Worker 会先确保目标组关系可见，再验证旧组属于同一 AList App 后移除旧关系。
INSERT INTO tf_access_operations(
  id, app_key, binding_id, app_transaction_id_hmac, operation_type,
  target_group_id, tester_id, stage, status, next_attempt_at, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))), b.app_key, b.id, b.app_transaction_id_hmac,
  'apply', '16b2ab29-bbde-4291-a4b7-77ee42eefb70', b.asc_tester_id,
  'prepared', 'active', b.updated_at, b.updated_at, b.updated_at
FROM tf_bindings b
WHERE b.status = 'active'
  AND b.beta_group_id != '16b2ab29-bbde-4291-a4b7-77ee42eefb70'
  AND NOT EXISTS (
    SELECT 1 FROM tf_access_operations o
    WHERE o.app_key = b.app_key AND o.binding_id = b.id
      AND o.status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1 FROM tf_web_rebind_operations r
    WHERE r.app_key = b.app_key AND r.binding_id = b.id
      AND r.terminal_state = 'active'
  );
