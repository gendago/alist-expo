export interface ClaimRow {
  id_hmac: string;
  app_transaction_id_hmac: string;
  state: string;
  email_hmac: string | null;
  expires_at: number;
  created_ip_hmac: string;
}

export interface BindingRow {
  id: number;
  app_transaction_id_hmac: string;
  email_hmac: string;
  email_ciphertext: string;
  asc_tester_id: string | null;
  status: string;
  asc_stage: string;
  asc_removal_state: string;
  rebind_count: number;
  beta_group_id: string;
}

export type AccessOperationStage =
  | "prepared"
  | "tester_resolving"
  | "tester_found"
  | "app_removing"
  | "app_removed"
  | "tester_adding"
  | "group_adding"
  | "group_visible"
  | "inviting"
  | "invited";

export interface AccessOperationRow {
  id: string;
  binding_id: number;
  app_transaction_id_hmac: string;
  operation_type: "apply" | "repair";
  target_group_id: string;
  tester_id: string | null;
  stage: AccessOperationStage;
  status: "active" | "completed" | "cancelled" | "failed_terminal";
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: number;
  error_kind: string | null;
  last_error: string | null;
  last_http_status: number | null;
  last_asc_code: string | null;
}

export interface WebRebindOperationRow {
  id: string;
  binding_id: number;
  app_transaction_id_hmac: string;
  from_email_hmac: string;
  target_email_hmac: string;
  target_email_ciphertext: string;
  old_tester_id: string | null;
  new_tester_id: string | null;
  expected_rebind_count: number;
  stage: "prepared" | "old_removing" | "old_removed" | "new_adding" | "new_invited";
  asc_stage: string;
  attempt_count: number;
  next_attempt_at: number;
  target_group_id: string;
  terminal_state: "active" | "completed" | "cancelled" | "failed_terminal";
  compensation_stage: "none" | "old_restoring" | "old_restored" | "failed_terminal";
  error_kind: string | null;
  last_error: string | null;
  last_http_status: number | null;
  last_asc_code: string | null;
  max_attempts: number;
  compensation_attempt_count: number;
  max_compensation_attempts: number;
}

export const OPERATION_LEASE_MS = 240_000;

export async function createClaim(
  env: Env,
  claimHmac: string,
  transactionHmac: string,
  ipHmac: string,
  now: number,
): Promise<void> {
  const result = await env.DB.prepare(
    `INSERT INTO tf_claim_sessions
      (id_hmac, app_key, app_transaction_id_hmac, created_ip_hmac, state, created_at, expires_at, updated_at)
     SELECT ?, ?, ?, ?, 'issued', ?, ?, ?
     WHERE (
       SELECT COUNT(*) FROM tf_claim_sessions
       WHERE app_key = ? AND app_transaction_id_hmac = ?
         AND state IN ('issued', 'applying', 'bound_pending_asc', 'failed_retryable')
         AND expires_at > ?
     ) < 3`,
  ).bind(
    claimHmac,
    env.APP_KEY,
    transactionHmac,
    ipHmac,
    now,
    now + 300_000,
    now,
    env.APP_KEY,
    transactionHmac,
    now,
  ).run();
  if (result.meta.changes !== 1) {
    const { AppError } = await import("./errors");
    throw new AppError("rate_limited", "too many active claims", 429, true);
  }
}

export async function findClaim(env: Env, claimHmac: string): Promise<ClaimRow | null> {
  return env.DB.prepare(
    `SELECT id_hmac, app_transaction_id_hmac, state, email_hmac, expires_at, created_ip_hmac
     FROM tf_claim_sessions WHERE id_hmac = ? AND app_key = ?`,
  ).bind(claimHmac, env.APP_KEY).first<ClaimRow>();
}

export async function acquireClaim(
  env: Env,
  claimHmac: string,
  emailHmac: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE tf_claim_sessions SET state = 'applying', email_hmac = ?, updated_at = ?
     WHERE id_hmac = ? AND app_key = ? AND expires_at > ?
       AND (
         state = 'issued'
         OR (state = 'failed_retryable' AND (email_hmac IS NULL OR email_hmac = ?))
       )`,
  ).bind(emailHmac, now, claimHmac, env.APP_KEY, now, emailHmac).run();
  return result.meta.changes === 1;
}

export async function setClaimState(
  env: Env,
  claimHmac: string,
  state: "bound_pending_asc" | "completed" | "failed_retryable",
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE tf_claim_sessions SET state = ?, consumed_at = CASE WHEN ? = 'completed' THEN ? ELSE consumed_at END,
      updated_at = ? WHERE id_hmac = ? AND app_key = ?
      AND (
        (? = 'bound_pending_asc' AND state IN ('applying', 'bound_pending_asc'))
        OR (? = 'completed' AND state IN ('applying', 'bound_pending_asc', 'failed_retryable', 'completed'))
        OR (? = 'failed_retryable' AND state IN ('applying', 'bound_pending_asc', 'failed_retryable'))
      )`,
  ).bind(
    state,
    state,
    now,
    now,
    claimHmac,
    env.APP_KEY,
    state,
    state,
    state,
  ).run();
  return result.meta.changes === 1;
}

export async function findBindingByTransaction(
  env: Env,
  transactionHmac: string,
): Promise<BindingRow | null> {
  return env.DB.prepare(
    `SELECT id, app_transaction_id_hmac, email_hmac, email_ciphertext, asc_tester_id,
      status, asc_stage, asc_removal_state, rebind_count, beta_group_id FROM tf_bindings
     WHERE app_key = ? AND app_transaction_id_hmac = ?`,
  ).bind(env.APP_KEY, transactionHmac).first<BindingRow>();
}

export async function findBindingByEmail(env: Env, emailHmac: string): Promise<BindingRow | null> {
  return env.DB.prepare(
    `SELECT id, app_transaction_id_hmac, email_hmac, email_ciphertext, asc_tester_id,
      status, asc_stage, asc_removal_state, rebind_count, beta_group_id FROM tf_bindings
     WHERE app_key = ? AND email_hmac = ?`,
  ).bind(env.APP_KEY, emailHmac).first<BindingRow>();
}

export async function findBindingsNeedingAccessRecovery(
  env: Env,
): Promise<BindingRow[]> {
  const result = await env.DB.prepare(
    `SELECT b.id, b.app_transaction_id_hmac, b.email_hmac, b.email_ciphertext,
      b.asc_tester_id, b.status, b.asc_stage, b.asc_removal_state,
      b.rebind_count, b.beta_group_id
     FROM tf_bindings b
     WHERE b.app_key = ? AND b.status = 'pending_asc'
       AND NOT EXISTS (
         SELECT 1 FROM tf_access_operations o
         WHERE o.app_key = b.app_key AND o.binding_id = b.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM tf_web_rebind_operations r
         WHERE r.app_key = b.app_key AND r.binding_id = b.id
           AND r.terminal_state = 'active'
       )
     ORDER BY b.updated_at LIMIT 20`,
  ).bind(env.APP_KEY).all<BindingRow>();
  return result.results;
}

export async function createBinding(
  env: Env,
  transactionHmac: string,
  emailHmac: string,
  emailCiphertext: string,
  now: number,
  betaGroupId: string = env.ASC_BETA_GROUP_ID,
): Promise<BindingRow> {
  await env.DB.prepare(
    `INSERT INTO tf_bindings
      (app_key, app_transaction_id_hmac, email_hmac, email_ciphertext, status, asc_stage,
       beta_group_id, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'pending_asc', 'binding_created', ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM tf_web_rebind_operations
       WHERE app_key = ? AND target_email_hmac = ?
         AND terminal_state = 'active'
     )`,
  ).bind(
    env.APP_KEY,
    transactionHmac,
    emailHmac,
    emailCiphertext,
    betaGroupId,
    now,
    now,
    env.APP_KEY,
    emailHmac,
  ).run();
  const row = await findBindingByTransaction(env, transactionHmac);
  if (!row) throw new Error("binding insert failed");
  return row;
}

export async function updateBindingAsc(
  env: Env,
  id: number,
  testerId: string,
  stage: string,
  active: boolean,
  betaGroupId?: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tf_bindings SET asc_tester_id = ?, asc_stage = ?,
      beta_group_id = COALESCE(?, beta_group_id),
      status = CASE WHEN ? AND status != 'revoked' THEN 'active' ELSE status END,
      updated_at = ? WHERE id = ? AND app_key = ?`,
  ).bind(
    testerId,
    stage,
    betaGroupId ?? null,
    active ? 1 : 0,
    Date.now(),
    id,
    env.APP_KEY,
  ).run();
}

const ACCESS_OPERATION_COLUMNS = `id, binding_id, app_transaction_id_hmac,
  operation_type, target_group_id, tester_id, stage, status, attempt_count,
  max_attempts, next_attempt_at, error_kind, last_error, last_http_status,
  last_asc_code`;

export async function findActiveAccessOperation(
  env: Env,
  bindingId: number,
): Promise<AccessOperationRow | null> {
  return env.DB.prepare(
    `SELECT ${ACCESS_OPERATION_COLUMNS} FROM tf_access_operations
     WHERE app_key = ? AND binding_id = ? AND status = 'active'`,
  ).bind(env.APP_KEY, bindingId).first<AccessOperationRow>();
}

export async function findAccessOperationById(
  env: Env,
  id: string,
): Promise<AccessOperationRow | null> {
  return env.DB.prepare(
    `SELECT ${ACCESS_OPERATION_COLUMNS} FROM tf_access_operations
     WHERE app_key = ? AND id = ?`,
  ).bind(env.APP_KEY, id).first<AccessOperationRow>();
}

export async function createAccessOperation(
  env: Env,
  binding: BindingRow,
  operationType: AccessOperationRow["operation_type"],
  targetGroupId: string,
  now: number,
): Promise<AccessOperationRow> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO tf_access_operations(
       id, app_key, binding_id, app_transaction_id_hmac, operation_type,
       target_group_id, tester_id, stage, status, next_attempt_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', 'active', ?, ?, ?)`,
  ).bind(
    id,
    env.APP_KEY,
    binding.id,
    binding.app_transaction_id_hmac,
    operationType,
    targetGroupId,
    binding.asc_tester_id,
    now,
    now,
    now,
  ).run();
  const operation = await findActiveAccessOperation(env, binding.id);
  if (!operation) throw new Error("access operation insert failed");
  return operation;
}

export async function compareAndSetAccessOperationStage(
  env: Env,
  id: string,
  expectedStage: AccessOperationStage,
  nextStage: AccessOperationStage,
  options: {
    testerId?: string;
    nextAttemptAt?: number;
  } = {},
): Promise<boolean> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE tf_access_operations SET stage = ?,
       tester_id = COALESCE(?, tester_id), next_attempt_at = ?,
       error_kind = NULL, last_error = NULL, last_http_status = NULL,
       last_asc_code = NULL, updated_at = ?
     WHERE id = ? AND app_key = ? AND status = 'active' AND stage = ?`,
  ).bind(
    nextStage,
    options.testerId ?? null,
    options.nextAttemptAt ?? now,
    now,
    id,
    env.APP_KEY,
    expectedStage,
  ).run();
  return result.meta.changes === 1;
}

export async function recordAccessOperationFailure(
  env: Env,
  id: string,
  error: {
    kind: string;
    safeMessage: string;
    httpStatus?: number;
    ascCode?: string;
    retryable: boolean;
    nextAttemptAt: number;
  },
): Promise<AccessOperationRow | null> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE tf_access_operations SET
       attempt_count = attempt_count + 1,
       status = CASE
         WHEN ? = 0 OR attempt_count + 1 >= max_attempts THEN 'failed_terminal'
         ELSE status
       END,
       next_attempt_at = ?, error_kind = ?, last_error = ?,
       last_http_status = ?, last_asc_code = ?,
       completed_at = CASE
         WHEN ? = 0 OR attempt_count + 1 >= max_attempts THEN ?
         ELSE completed_at
       END,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND app_key = ? AND status = 'active'`,
  ).bind(
    error.retryable ? 1 : 0,
    error.nextAttemptAt,
    error.kind,
    error.safeMessage,
    error.httpStatus ?? null,
    error.ascCode ?? null,
    error.retryable ? 1 : 0,
    now,
    now,
    id,
    env.APP_KEY,
  ).run();
  return findAccessOperationById(env, id);
}

export async function convertRepairToApplyRecovery(
  env: Env,
  id: string,
  error: {
    kind: string;
    safeMessage: string;
    httpStatus?: number;
    ascCode?: string;
    nextAttemptAt: number;
  },
): Promise<boolean> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE tf_access_operations SET operation_type = 'apply',
       stage = 'tester_adding', attempt_count = 0,
       next_attempt_at = ?, error_kind = ?, last_error = ?,
       last_http_status = ?, last_asc_code = ?,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND app_key = ? AND status = 'active'
       AND operation_type = 'repair'
       AND stage IN ('app_removing', 'app_removed', 'tester_adding',
         'group_adding', 'group_visible', 'inviting', 'invited')`,
  ).bind(
    error.nextAttemptAt,
    error.kind,
    error.safeMessage,
    error.httpStatus ?? null,
    error.ascCode ?? null,
    now,
    id,
    env.APP_KEY,
  ).run();
  return result.meta.changes === 1;
}

export async function completeAccessOperation(
  env: Env,
  id: string,
  bindingId: number,
  testerId: string,
  targetGroupId: string,
): Promise<boolean> {
  const now = Date.now();
  const [operationResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE tf_access_operations SET status = 'completed', stage = 'invited',
       tester_id = ?, completed_at = ?, next_attempt_at = ?, error_kind = NULL,
       last_error = NULL, last_http_status = NULL, last_asc_code = NULL,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND app_key = ? AND binding_id = ? AND status = 'active'
         AND stage IN ('group_visible', 'inviting', 'invited')`,
    ).bind(testerId, now, now, now, id, env.APP_KEY, bindingId),
    env.DB.prepare(
      `UPDATE tf_bindings SET asc_tester_id = ?, beta_group_id = ?,
       status = CASE WHEN status = 'revoked' THEN status ELSE 'active' END,
       asc_stage = 'invited', updated_at = ?
       WHERE id = ? AND app_key = ?
         AND EXISTS (
           SELECT 1 FROM tf_access_operations
           WHERE id = ? AND app_key = ? AND binding_id = ?
             AND status = 'completed' AND tester_id = ? AND target_group_id = ?
         )`,
    ).bind(
      testerId,
      targetGroupId,
      now,
      bindingId,
      env.APP_KEY,
      id,
      env.APP_KEY,
      bindingId,
      testerId,
      targetGroupId,
    ),
  ]);
  return operationResult?.meta.changes === 1;
}

export async function cancelAccessOperation(env: Env, id: string): Promise<boolean> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE tf_access_operations SET status = 'cancelled', completed_at = ?,
       next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND app_key = ? AND status = 'active'`,
  ).bind(now, now, now, id, env.APP_KEY).run();
  return result.meta.changes === 1;
}

export async function findRecoverableAccessOperations(
  env: Env,
  now: number,
): Promise<AccessOperationRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${ACCESS_OPERATION_COLUMNS} FROM tf_access_operations
     WHERE app_key = ? AND status = 'active' AND attempt_count < max_attempts
       AND next_attempt_at <= ?
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
     ORDER BY updated_at LIMIT 20`,
  ).bind(env.APP_KEY, now, now).all<AccessOperationRow>();
  return result.results;
}

export async function acquireAccessOperationLease(
  env: Env,
  id: string,
  owner: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE tf_access_operations SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND app_key = ? AND status = 'active'
       AND attempt_count < max_attempts
       AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)`,
  ).bind(owner, now + OPERATION_LEASE_MS, now, id, env.APP_KEY, now, owner).run();
  return result.meta.changes === 1;
}

export async function releaseAccessOperationLease(
  env: Env,
  id: string,
  owner: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tf_access_operations SET lease_owner = NULL, lease_expires_at = NULL,
       updated_at = ? WHERE id = ? AND app_key = ? AND lease_owner = ?`,
  ).bind(Date.now(), id, env.APP_KEY, owner).run();
}

export async function findActiveWebRebindOperation(
  env: Env,
  transactionHmac: string,
): Promise<WebRebindOperationRow | null> {
  return env.DB.prepare(
    `SELECT id, binding_id, app_transaction_id_hmac, from_email_hmac,
      target_email_hmac, target_email_ciphertext, old_tester_id, new_tester_id,
      expected_rebind_count, stage, asc_stage, attempt_count, next_attempt_at,
      target_group_id, terminal_state, compensation_stage, error_kind,
      last_error, last_http_status, last_asc_code, max_attempts,
      compensation_attempt_count, max_compensation_attempts
     FROM tf_web_rebind_operations
     WHERE app_key = ? AND app_transaction_id_hmac = ?
       AND terminal_state = 'active'`,
  ).bind(env.APP_KEY, transactionHmac).first<WebRebindOperationRow>();
}

export async function createWebRebindOperation(
  env: Env,
  binding: BindingRow,
  targetEmailHmac: string,
  targetEmailCiphertext: string,
  now: number,
  targetGroupId: string = env.ASC_BETA_GROUP_ID,
): Promise<WebRebindOperationRow | null> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO tf_web_rebind_operations(
       id, app_key, binding_id, app_transaction_id_hmac, from_email_hmac,
       target_email_hmac, target_email_ciphertext, old_tester_id,
       expected_rebind_count, stage, target_group_id, next_attempt_at, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM tf_bindings
       WHERE app_key = ? AND email_hmac = ? AND id != ?
     )`,
  ).bind(
    id,
    env.APP_KEY,
    binding.id,
    binding.app_transaction_id_hmac,
    binding.email_hmac,
    targetEmailHmac,
    targetEmailCiphertext,
    binding.asc_tester_id,
    binding.rebind_count,
    targetGroupId,
    now,
    now,
    now,
    env.APP_KEY,
    targetEmailHmac,
    binding.id,
  ).run();
  return findActiveWebRebindOperation(env, binding.app_transaction_id_hmac);
}

export async function updateWebRebindStage(
  env: Env,
  id: string,
  stage: WebRebindOperationRow["stage"],
  options: {
    newTesterId?: string;
    ascStage?: string;
    error?: string | null;
    errorKind?: string | null;
    httpStatus?: number | null;
    ascCode?: string | null;
    nextAttemptAt?: number;
    terminal?: boolean;
    compensationStage?: WebRebindOperationRow["compensation_stage"];
  } = {},
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE tf_web_rebind_operations SET stage = ?,
      new_tester_id = COALESCE(?, new_tester_id),
      asc_stage = COALESCE(?, asc_stage),
      attempt_count = attempt_count + CASE WHEN ? IS NULL THEN 0 ELSE 1 END,
      next_attempt_at = ?, last_error = ?, error_kind = ?,
      last_http_status = ?, last_asc_code = ?,
      terminal_state = CASE
        WHEN ? THEN 'failed_terminal'
        ELSE terminal_state
      END,
      compensation_stage = COALESCE(?, compensation_stage),
      completed_at = CASE
        WHEN ? THEN ?
        ELSE completed_at
      END,
      updated_at = ?
     WHERE id = ? AND app_key = ? AND terminal_state = 'active'`,
  ).bind(
    stage,
    options.newTesterId ?? null,
    options.ascStage ?? null,
    options.error ?? null,
    options.nextAttemptAt ?? now + (options.error ? 300_000 : 0),
    options.error ?? null,
    options.errorKind ?? null,
    options.httpStatus ?? null,
    options.ascCode ?? null,
    options.terminal ? 1 : 0,
    options.compensationStage ?? null,
    options.terminal ? 1 : 0,
    now,
    now,
    id,
    env.APP_KEY,
  ).run();
}

export async function compareAndSetWebRebindStage(
  env: Env,
  id: string,
  expectedStage: WebRebindOperationRow["stage"],
  nextStage: WebRebindOperationRow["stage"],
  options: { newTesterId?: string; ascStage?: string; nextAttemptAt?: number } = {},
): Promise<boolean> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE tf_web_rebind_operations SET stage = ?,
       new_tester_id = COALESCE(?, new_tester_id),
       asc_stage = COALESCE(?, asc_stage), next_attempt_at = ?,
       error_kind = NULL, last_error = NULL, last_http_status = NULL,
       last_asc_code = NULL, updated_at = ?
     WHERE id = ? AND app_key = ? AND terminal_state = 'active'
       AND compensation_stage = 'none' AND stage = ?`,
  ).bind(
    nextStage,
    options.newTesterId ?? null,
    options.ascStage ?? null,
    options.nextAttemptAt ?? now,
    now,
    id,
    env.APP_KEY,
    expectedStage,
  ).run();
  return result.meta.changes === 1;
}

export async function recordWebRebindFailure(
  env: Env,
  id: string,
  error: {
    kind: string;
    safeMessage: string;
    httpStatus?: number;
    ascCode?: string;
    retryable: boolean;
    nextAttemptAt: number;
  },
): Promise<WebRebindOperationRow | null> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE tf_web_rebind_operations SET
       attempt_count = attempt_count + 1,
       compensation_stage = CASE
         WHEN (? = 0 OR attempt_count + 1 >= max_attempts)
           AND stage IN ('old_removing', 'old_removed', 'new_adding', 'new_invited')
           THEN 'old_restoring'
         ELSE compensation_stage
       END,
       terminal_state = CASE
         WHEN (? = 0 OR attempt_count + 1 >= max_attempts) AND stage = 'prepared'
           THEN 'failed_terminal'
         ELSE terminal_state
       END,
       next_attempt_at = CASE
         WHEN (? = 0 OR attempt_count + 1 >= max_attempts) THEN ?
         ELSE ?
       END,
       error_kind = ?, last_error = ?, last_http_status = ?, last_asc_code = ?,
       target_email_ciphertext = CASE
         WHEN (? = 0 OR attempt_count + 1 >= max_attempts) AND stage = 'prepared'
           THEN ''
         ELSE target_email_ciphertext
       END,
       completed_at = CASE
         WHEN (? = 0 OR attempt_count + 1 >= max_attempts) AND stage = 'prepared'
           THEN ?
         ELSE completed_at
       END,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND app_key = ? AND terminal_state = 'active'
       AND compensation_stage = 'none'`,
  ).bind(
    error.retryable ? 1 : 0,
    error.retryable ? 1 : 0,
    error.retryable ? 1 : 0,
    now,
    error.nextAttemptAt,
    error.kind,
    error.safeMessage,
    error.httpStatus ?? null,
    error.ascCode ?? null,
    error.retryable ? 1 : 0,
    error.retryable ? 1 : 0,
    now,
    now,
    id,
    env.APP_KEY,
  ).run();
  return env.DB.prepare(
    `SELECT id, binding_id, app_transaction_id_hmac, from_email_hmac,
      target_email_hmac, target_email_ciphertext, old_tester_id, new_tester_id,
      expected_rebind_count, stage, asc_stage, attempt_count, next_attempt_at,
      target_group_id, terminal_state, compensation_stage, error_kind,
      last_error, last_http_status, last_asc_code, max_attempts,
      compensation_attempt_count, max_compensation_attempts
     FROM tf_web_rebind_operations WHERE id = ? AND app_key = ?`,
  ).bind(id, env.APP_KEY).first<WebRebindOperationRow>();
}

export async function recordWebRebindCompensationFailure(
  env: Env,
  id: string,
  error: {
    kind: string;
    safeMessage: string;
    httpStatus?: number;
    ascCode?: string;
    retryable: boolean;
    nextAttemptAt: number;
  },
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE tf_web_rebind_operations SET
       compensation_attempt_count = compensation_attempt_count + 1,
       compensation_stage = CASE
         WHEN ? = 0 OR compensation_attempt_count + 1 >= max_compensation_attempts
           THEN 'failed_terminal'
         ELSE compensation_stage
       END,
       terminal_state = CASE
         WHEN ? = 0 OR compensation_attempt_count + 1 >= max_compensation_attempts
           THEN 'failed_terminal'
         ELSE terminal_state
       END,
       target_email_ciphertext = CASE
         WHEN ? = 0 OR compensation_attempt_count + 1 >= max_compensation_attempts
           THEN ''
         ELSE target_email_ciphertext
       END,
       next_attempt_at = ?, error_kind = ?, last_error = ?,
       last_http_status = ?, last_asc_code = ?,
       completed_at = CASE
         WHEN ? = 0 OR compensation_attempt_count + 1 >= max_compensation_attempts
           THEN ?
         ELSE completed_at
       END,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND app_key = ? AND terminal_state = 'active'
       AND compensation_stage = 'old_restoring'`,
  ).bind(
    error.retryable ? 1 : 0,
    error.retryable ? 1 : 0,
    error.retryable ? 1 : 0,
    error.nextAttemptAt,
    error.kind,
    error.safeMessage,
    error.httpStatus ?? null,
    error.ascCode ?? null,
    error.retryable ? 1 : 0,
    now,
    now,
    id,
    env.APP_KEY,
  ).run();
}

export async function completeWebRebindCompensation(
  env: Env,
  id: string,
): Promise<boolean> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE tf_web_rebind_operations SET compensation_stage = 'old_restored',
       terminal_state = 'cancelled', target_email_ciphertext = '',
       completed_at = ?, next_attempt_at = ?, error_kind = NULL, last_error = NULL,
       last_http_status = NULL, last_asc_code = NULL,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND app_key = ? AND terminal_state = 'active'
       AND compensation_stage = 'old_restoring'`,
  ).bind(now, now, now, id, env.APP_KEY).run();
  return result.meta.changes === 1;
}

export async function cancelWebRebindOperation(
  env: Env,
  id: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tf_web_rebind_operations SET stage = 'cancelled', terminal_state = 'cancelled',
      target_email_ciphertext = '', completed_at = ?, next_attempt_at = ?,
      last_error = NULL, error_kind = NULL, last_http_status = NULL,
      last_asc_code = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND app_key = ? AND terminal_state = 'active'`,
  ).bind(Date.now(), Date.now(), Date.now(), id, env.APP_KEY).run();
}

export async function completeWebRebind(
  env: Env,
  operation: WebRebindOperationRow,
): Promise<boolean> {
  if (!operation.new_tester_id) return false;
  const now = Date.now();
  const [bindingResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE tf_bindings SET email_hmac = ?, email_ciphertext = ?,
        asc_tester_id = ?, status = 'active', asc_stage = 'rebind_invited',
        beta_group_id = ?, rebind_count = rebind_count + 1, updated_at = ?
       WHERE id = ? AND app_key = ? AND status != 'revoked'
         AND email_hmac = ? AND rebind_count = ? AND rebind_count < 2`,
    ).bind(
      operation.target_email_hmac,
      operation.target_email_ciphertext,
      operation.new_tester_id,
      operation.target_group_id,
      now,
      operation.binding_id,
      env.APP_KEY,
      operation.from_email_hmac,
      operation.expected_rebind_count,
    ),
    env.DB.prepare(
      `UPDATE tf_web_rebind_operations SET stage = 'completed', terminal_state = 'completed',
        target_email_ciphertext = '', completed_at = ?, next_attempt_at = ?,
        last_error = NULL, error_kind = NULL, last_http_status = NULL,
        last_asc_code = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND app_key = ? AND stage = 'new_invited'
         AND EXISTS (
           SELECT 1 FROM tf_bindings
           WHERE id = ? AND app_key = ? AND email_hmac = ?
             AND rebind_count = ?
         )`,
    ).bind(
      now,
      now,
      now,
      operation.id,
      env.APP_KEY,
      operation.binding_id,
      env.APP_KEY,
      operation.target_email_hmac,
      operation.expected_rebind_count + 1,
    ),
  ]);
  if (bindingResult?.meta.changes === 1) return true;
  const current = await findBindingByTransaction(
    env,
    operation.app_transaction_id_hmac,
  );
  return current?.email_hmac === operation.target_email_hmac &&
    current.rebind_count === operation.expected_rebind_count + 1;
}

export async function findRecoverableWebRebindOperations(
  env: Env,
  now: number,
): Promise<WebRebindOperationRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, binding_id, app_transaction_id_hmac, from_email_hmac,
      target_email_hmac, target_email_ciphertext, old_tester_id, new_tester_id,
      expected_rebind_count, stage, asc_stage, attempt_count, next_attempt_at,
      target_group_id, terminal_state, compensation_stage, error_kind,
      last_error, last_http_status, last_asc_code, max_attempts,
      compensation_attempt_count, max_compensation_attempts
     FROM tf_web_rebind_operations
     WHERE app_key = ? AND terminal_state = 'active'
       AND (
         (compensation_stage = 'none' AND attempt_count < max_attempts)
         OR (
           compensation_stage = 'old_restoring'
           AND compensation_attempt_count < max_compensation_attempts
         )
       )
       AND next_attempt_at <= ?
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
     ORDER BY updated_at LIMIT 20`,
  ).bind(env.APP_KEY, now, now).all<WebRebindOperationRow>();
  return result.results;
}

export async function acquireWebRebindOperationLease(
  env: Env,
  id: string,
  owner: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE tf_web_rebind_operations
     SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND app_key = ? AND terminal_state = 'active'
       AND (
         (compensation_stage = 'none' AND attempt_count < max_attempts)
         OR (
           compensation_stage = 'old_restoring'
           AND compensation_attempt_count < max_compensation_attempts
         )
       )
       AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)`,
  ).bind(owner, now + OPERATION_LEASE_MS, now, id, env.APP_KEY, now, owner).run();
  return result.meta.changes === 1;
}

export async function releaseWebRebindOperationLease(
  env: Env,
  id: string,
  owner: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tf_web_rebind_operations
     SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND app_key = ? AND lease_owner = ?`,
  ).bind(Date.now(), id, env.APP_KEY, owner).run();
}

export async function markBindingRevoked(
  env: Env,
  id: number,
  revokedAt: number,
  evidenceHmac: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tf_bindings SET status = 'revoked', revoked_at = ?,
      revocation_evidence_hmac = ?, asc_removal_state =
        CASE WHEN asc_removal_state = 'completed' THEN 'completed' ELSE 'pending' END,
      updated_at = ? WHERE id = ? AND app_key = ?`,
  ).bind(revokedAt, evidenceHmac, Date.now(), id, env.APP_KEY).run();
}

export async function setRemovalState(
  env: Env,
  id: number,
  state: "completed" | "failed_retryable",
  error: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tf_bindings SET asc_removal_state = ?, asc_removal_last_error = ?,
      updated_at = ? WHERE id = ? AND app_key = ?`,
  ).bind(state, error, Date.now(), id, env.APP_KEY).run();
}

export async function acquireLease(
  env: Env,
  resourceHmac: string,
  owner: string,
  operation: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO tf_operation_leases(resource_hmac, owner_id, operation, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(resource_hmac) DO UPDATE SET owner_id = excluded.owner_id,
       operation = excluded.operation, expires_at = excluded.expires_at, updated_at = excluded.updated_at
     WHERE tf_operation_leases.expires_at <= ?`,
  ).bind(resourceHmac, owner, operation, now + OPERATION_LEASE_MS, now, now).run();
  return result.meta.changes === 1;
}

export async function releaseLease(env: Env, resourceHmac: string, owner: string): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM tf_operation_leases WHERE resource_hmac = ? AND owner_id = ?",
  ).bind(resourceHmac, owner).run();
}

export async function renewLease(
  env: Env,
  resourceHmac: string,
  owner: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE tf_operation_leases
     SET expires_at = ?, updated_at = ?
     WHERE resource_hmac = ? AND owner_id = ? AND expires_at > ?`,
  ).bind(now + OPERATION_LEASE_MS, now, resourceHmac, owner, now).run();
  return result.meta.changes === 1;
}
