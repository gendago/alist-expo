-- 历史绑定均来自原来的 “AList Server” TestFlight 分组。
ALTER TABLE tf_bindings
  ADD COLUMN beta_group_id TEXT NOT NULL
  DEFAULT 'c7ca74ed-8a19-4c4b-9a81-ad3d4b235081';

-- 首次申请和同邮箱修复共用一套可恢复的持久化状态机。
CREATE TABLE tf_access_operations (
  id TEXT PRIMARY KEY,
  app_key TEXT NOT NULL CHECK (app_key = 'alist'),
  binding_id INTEGER NOT NULL,
  app_transaction_id_hmac TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('apply', 'repair')),
  target_group_id TEXT NOT NULL,
  tester_id TEXT,
  stage TEXT NOT NULL CHECK (stage IN (
    'prepared', 'tester_resolving', 'tester_found', 'app_removing',
    'app_removed', 'tester_adding', 'group_adding', 'group_visible',
    'inviting', 'invited'
  )),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'completed', 'cancelled', 'failed_terminal')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  next_attempt_at INTEGER NOT NULL,
  error_kind TEXT,
  last_error TEXT,
  last_http_status INTEGER,
  last_asc_code TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (binding_id) REFERENCES tf_bindings(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_access_operation_active_binding
  ON tf_access_operations(app_key, binding_id)
  WHERE status = 'active';

CREATE INDEX idx_access_operation_recovery
  ON tf_access_operations(app_key, status, next_attempt_at, attempt_count, updated_at);

-- 为已经停在 pending_asc 的历史申请补建恢复任务；目标统一迁移到当前“已购用户”分组。
INSERT INTO tf_access_operations(
  id, app_key, binding_id, app_transaction_id_hmac, operation_type,
  target_group_id, tester_id, stage, status, next_attempt_at, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))), app_key, id, app_transaction_id_hmac, 'apply',
  '16b2ab29-bbde-4291-a4b7-77ee42eefb70', asc_tester_id,
  'prepared', 'active', updated_at, updated_at, updated_at
FROM tf_bindings
WHERE status = 'pending_asc'
  AND NOT EXISTS (
    SELECT 1 FROM tf_web_rebind_operations r
    WHERE r.app_key = tf_bindings.app_key
      AND r.binding_id = tf_bindings.id
      AND r.stage NOT IN ('completed', 'cancelled')
  );

-- 自助换绑保留现有阶段，并补齐目标组快照、有限重试、终态错误与恢复旧邮箱所需字段。
ALTER TABLE tf_web_rebind_operations
  ADD COLUMN target_group_id TEXT NOT NULL
  DEFAULT '16b2ab29-bbde-4291-a4b7-77ee42eefb70';
ALTER TABLE tf_web_rebind_operations
  ADD COLUMN terminal_state TEXT NOT NULL DEFAULT 'active'
  CHECK (terminal_state IN ('active', 'completed', 'cancelled', 'failed_terminal'));
ALTER TABLE tf_web_rebind_operations
  ADD COLUMN compensation_stage TEXT NOT NULL DEFAULT 'none'
  CHECK (compensation_stage IN ('none', 'old_restoring', 'old_restored', 'failed_terminal'));
ALTER TABLE tf_web_rebind_operations ADD COLUMN error_kind TEXT;
ALTER TABLE tf_web_rebind_operations ADD COLUMN last_http_status INTEGER;
ALTER TABLE tf_web_rebind_operations ADD COLUMN last_asc_code TEXT;
ALTER TABLE tf_web_rebind_operations
  ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0);
ALTER TABLE tf_web_rebind_operations
  ADD COLUMN compensation_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tf_web_rebind_operations
  ADD COLUMN max_compensation_attempts INTEGER NOT NULL DEFAULT 8
  CHECK (max_compensation_attempts > 0);
ALTER TABLE tf_web_rebind_operations ADD COLUMN lease_owner TEXT;
ALTER TABLE tf_web_rebind_operations ADD COLUMN lease_expires_at INTEGER;

UPDATE tf_web_rebind_operations
SET terminal_state = CASE
  WHEN stage = 'completed' THEN 'completed'
  WHEN stage = 'cancelled' THEN 'cancelled'
  ELSE 'active'
END;

DROP INDEX idx_web_rebind_active_binding;
DROP INDEX idx_web_rebind_active_target;

CREATE UNIQUE INDEX idx_web_rebind_active_binding
  ON tf_web_rebind_operations(app_key, binding_id)
  WHERE terminal_state = 'active';

CREATE UNIQUE INDEX idx_web_rebind_active_target
  ON tf_web_rebind_operations(app_key, target_email_hmac)
  WHERE terminal_state = 'active';

CREATE INDEX idx_web_rebind_bounded_recovery
  ON tf_web_rebind_operations(
    app_key, terminal_state, next_attempt_at, attempt_count, updated_at
  );
