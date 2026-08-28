-- 早期全局邮箱回退可能误选只属于其他 App 的 tester，ASC 会在加组时返回
-- 409 STATE_ERROR。新版 Worker 不再复用跨 App tester；仅将本次已确认的
-- 未完成初绑重置到 tester_adding，由恢复任务为 AListServer 创建独立 tester。
UPDATE tf_bindings
SET asc_tester_id = NULL,
    asc_stage = 'none',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE app_key = 'alist'
  AND status = 'pending_asc'
  AND id = (
    SELECT o.binding_id
    FROM tf_access_operations o
    WHERE o.id = '4c0993121743d436b10897dfe3384d1b'
      AND o.app_key = 'alist'
      AND o.operation_type = 'apply'
      AND o.stage = 'group_adding'
      AND o.status = 'failed_terminal'
      AND o.last_http_status = 409
      AND o.last_asc_code = 'STATE_ERROR'
      AND NOT EXISTS (
        SELECT 1 FROM tf_access_operations active_o
        WHERE active_o.app_key = o.app_key
          AND active_o.binding_id = o.binding_id
          AND active_o.status = 'active'
      )
      AND NOT EXISTS (
        SELECT 1 FROM tf_web_rebind_operations r
        WHERE r.app_key = o.app_key
          AND r.binding_id = o.binding_id
          AND r.terminal_state = 'active'
      )
  );

UPDATE tf_access_operations
SET tester_id = NULL,
    stage = 'tester_adding',
    status = 'active',
    attempt_count = 0,
    next_attempt_at = 0,
    error_kind = NULL,
    last_error = NULL,
    last_http_status = NULL,
    last_asc_code = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    completed_at = NULL,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = '4c0993121743d436b10897dfe3384d1b'
  AND app_key = 'alist'
  AND operation_type = 'apply'
  AND stage = 'group_adding'
  AND status = 'failed_terminal'
  AND last_http_status = 409
  AND last_asc_code = 'STATE_ERROR'
  AND binding_id IN (
    SELECT b.id FROM tf_bindings b
    WHERE b.app_key = 'alist'
      AND b.status = 'pending_asc'
      AND b.asc_tester_id IS NULL
      AND b.asc_stage = 'none'
  )
  AND NOT EXISTS (
    SELECT 1 FROM tf_access_operations active_o
    WHERE active_o.app_key = tf_access_operations.app_key
      AND active_o.binding_id = tf_access_operations.binding_id
      AND active_o.status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1 FROM tf_web_rebind_operations r
    WHERE r.app_key = tf_access_operations.app_key
      AND r.binding_id = tf_access_operations.binding_id
      AND r.terminal_state = 'active'
  );
