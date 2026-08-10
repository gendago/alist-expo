export interface ClaimRow {
  id_hmac: string;
  app_transaction_id_hmac: string;
  state: string;
  email_hmac: string | null;
  expires_at: number;
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
}

export const OPERATION_LEASE_MS = 240_000;

export async function createClaim(
  env: Env,
  claimHmac: string,
  transactionHmac: string,
  ipHmac: string,
  now: number,
): Promise<void> {
  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM tf_claim_sessions
     WHERE app_key = ? AND app_transaction_id_hmac = ?
       AND state IN ('issued', 'applying', 'bound_pending_asc', 'failed_retryable')
       AND expires_at > ?`,
  ).bind(env.APP_KEY, transactionHmac, now).first<{ count: number }>();
  if ((active?.count ?? 0) >= 3) {
    throw new (await import("./errors")).AppError("rate_limited", "too many active claims", 429, true);
  }
  await env.DB.prepare(
    `INSERT INTO tf_claim_sessions
      (id_hmac, app_key, app_transaction_id_hmac, created_ip_hmac, state, created_at, expires_at, updated_at)
     VALUES (?, ?, ?, ?, 'issued', ?, ?, ?)`,
  ).bind(claimHmac, env.APP_KEY, transactionHmac, ipHmac, now, now + 300_000, now).run();
}

export async function findClaim(env: Env, claimHmac: string): Promise<ClaimRow | null> {
  return env.DB.prepare(
    `SELECT id_hmac, app_transaction_id_hmac, state, email_hmac, expires_at
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
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tf_claim_sessions SET state = ?, consumed_at = CASE WHEN ? = 'completed' THEN ? ELSE consumed_at END,
      updated_at = ? WHERE id_hmac = ? AND app_key = ?`,
  ).bind(state, state, now, now, claimHmac, env.APP_KEY).run();
}

export async function findBindingByTransaction(
  env: Env,
  transactionHmac: string,
): Promise<BindingRow | null> {
  return env.DB.prepare(
    `SELECT id, app_transaction_id_hmac, email_hmac, email_ciphertext, asc_tester_id,
      status, asc_stage, asc_removal_state, rebind_count FROM tf_bindings
     WHERE app_key = ? AND app_transaction_id_hmac = ?`,
  ).bind(env.APP_KEY, transactionHmac).first<BindingRow>();
}

export async function findBindingByEmail(env: Env, emailHmac: string): Promise<BindingRow | null> {
  return env.DB.prepare(
    `SELECT id, app_transaction_id_hmac, email_hmac, email_ciphertext, asc_tester_id,
      status, asc_stage, asc_removal_state, rebind_count FROM tf_bindings
     WHERE app_key = ? AND email_hmac = ?`,
  ).bind(env.APP_KEY, emailHmac).first<BindingRow>();
}

export async function createBinding(
  env: Env,
  transactionHmac: string,
  emailHmac: string,
  emailCiphertext: string,
  now: number,
): Promise<BindingRow> {
  await env.DB.prepare(
    `INSERT INTO tf_bindings
      (app_key, app_transaction_id_hmac, email_hmac, email_ciphertext, status, asc_stage, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'pending_asc', 'binding_created', ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM tf_web_rebind_operations
       WHERE app_key = ? AND target_email_hmac = ?
         AND stage NOT IN ('completed', 'cancelled')
     )`,
  ).bind(
    env.APP_KEY,
    transactionHmac,
    emailHmac,
    emailCiphertext,
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
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tf_bindings SET asc_tester_id = ?, asc_stage = ?,
      status = CASE WHEN ? AND status != 'revoked' THEN 'active' ELSE status END,
      updated_at = ? WHERE id = ? AND app_key = ?`,
  ).bind(testerId, stage, active ? 1 : 0, Date.now(), id, env.APP_KEY).run();
}

export async function findActiveWebRebindOperation(
  env: Env,
  transactionHmac: string,
): Promise<WebRebindOperationRow | null> {
  return env.DB.prepare(
    `SELECT id, binding_id, app_transaction_id_hmac, from_email_hmac,
      target_email_hmac, target_email_ciphertext, old_tester_id, new_tester_id,
      expected_rebind_count, stage, asc_stage, attempt_count, next_attempt_at
     FROM tf_web_rebind_operations
     WHERE app_key = ? AND app_transaction_id_hmac = ?
       AND stage NOT IN ('completed', 'cancelled')`,
  ).bind(env.APP_KEY, transactionHmac).first<WebRebindOperationRow>();
}

export async function createWebRebindOperation(
  env: Env,
  binding: BindingRow,
  targetEmailHmac: string,
  targetEmailCiphertext: string,
  now: number,
): Promise<WebRebindOperationRow | null> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO tf_web_rebind_operations(
       id, app_key, binding_id, app_transaction_id_hmac, from_email_hmac,
       target_email_hmac, target_email_ciphertext, old_tester_id,
       expected_rebind_count, stage, next_attempt_at, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?
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
  options: { newTesterId?: string; ascStage?: string; error?: string | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tf_web_rebind_operations SET stage = ?,
      new_tester_id = COALESCE(?, new_tester_id),
      asc_stage = COALESCE(?, asc_stage),
      attempt_count = attempt_count + CASE WHEN ? IS NULL THEN 0 ELSE 1 END,
      next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND app_key = ? AND stage NOT IN ('completed', 'cancelled')`,
  ).bind(
    stage,
    options.newTesterId ?? null,
    options.ascStage ?? null,
    options.error ?? null,
    Date.now() + (options.error ? 300_000 : 0),
    options.error ?? null,
    Date.now(),
    id,
    env.APP_KEY,
  ).run();
}

export async function cancelWebRebindOperation(
  env: Env,
  id: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tf_web_rebind_operations SET stage = 'cancelled',
      target_email_ciphertext = '', completed_at = ?, next_attempt_at = ?,
      last_error = NULL, updated_at = ?
     WHERE id = ? AND app_key = ? AND stage NOT IN ('completed', 'cancelled')`,
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
        rebind_count = rebind_count + 1, updated_at = ?
       WHERE id = ? AND app_key = ? AND status != 'revoked'
         AND email_hmac = ? AND rebind_count = ? AND rebind_count < 2`,
    ).bind(
      operation.target_email_hmac,
      operation.target_email_ciphertext,
      operation.new_tester_id,
      now,
      operation.binding_id,
      env.APP_KEY,
      operation.from_email_hmac,
      operation.expected_rebind_count,
    ),
    env.DB.prepare(
      `UPDATE tf_web_rebind_operations SET stage = 'completed',
        target_email_ciphertext = '', completed_at = ?, next_attempt_at = ?,
        last_error = NULL, updated_at = ?
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
      expected_rebind_count, stage, asc_stage, attempt_count, next_attempt_at
     FROM tf_web_rebind_operations
     WHERE app_key = ? AND stage NOT IN ('completed', 'cancelled')
       AND next_attempt_at <= ? ORDER BY updated_at LIMIT 20`,
  ).bind(env.APP_KEY, now).all<WebRebindOperationRow>();
  return result.results;
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
