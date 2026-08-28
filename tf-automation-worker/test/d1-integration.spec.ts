import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareAndSetAccessOperationStage,
  compareAndSetWebRebindStage,
  completeAccessOperation,
  convertRepairToApplyRecovery,
  completeWebRebindCompensation,
  createAccessOperation,
  cancelWebRebindOperation,
  completeWebRebind,
  createBinding,
  createClaim,
  createWebRebindOperation,
  findActiveAccessOperation,
  findActiveWebRebindOperation,
  findBindingByTransaction,
  findClaim,
  recordAccessOperationFailure,
  recordWebRebindCompensationFailure,
  recordWebRebindFailure,
  setClaimState,
  updateWebRebindStage,
} from "../src/repository";

let miniflare: Miniflare;
let database: D1Database;

const MIGRATIONS = [
  "0001_alistserver_init.sql",
  "0002_feishu_events.sql",
  "0003_feishu_rebind_jobs.sql",
  "0004_feishu_card_recovery.sql",
  "0005_feishu_card_lease.sql",
  "0006_feishu_direct_binding.sql",
  "0007_feishu_intended_operation.sql",
  "0008_web_rebind_limit.sql",
  "0009_tf_access_reliability.sql",
  "0010_reconcile_purchased_group.sql",
  "0011_pending_email_retry.sql",
  "0012_retry_cross_app_tester.sql",
];

async function applyMigrations(
  target: D1Database,
  names: string[],
): Promise<void> {
  for (const name of names) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
      await target.prepare(statement).run();
    }
  }
}

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-07-27",
    d1Databases: { DB: "alist-tf-integration" },
  });
  database = await miniflare.getD1Database("DB");
  await applyMigrations(database, MIGRATIONS);
});

afterEach(async () => {
  await miniflare.dispose();
});

describe("真实 workerd D1 迁移与并发语义", () => {
  it("带历史数据从 0008 升级时补建 pending/分组迁移任务并避开活动换绑", async () => {
    const upgrade = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2026-07-27",
      d1Databases: { DB: "alist-tf-upgrade" },
    });
    try {
      const upgradeDb = await upgrade.getD1Database("DB");
      await applyMigrations(upgradeDb, MIGRATIONS.slice(0, 8));
      const now = Date.now();
      await upgradeDb.batch([
        upgradeDb.prepare(
          `INSERT INTO tf_bindings(
            app_key,app_transaction_id_hmac,email_hmac,email_ciphertext,
            status,asc_stage,created_at,updated_at
          ) VALUES ('alist','pending-recover','email-a','cipher-a',
            'pending_asc','tester_found',?,?)`,
        ).bind(now, now),
        upgradeDb.prepare(
          `INSERT INTO tf_bindings(
            app_key,app_transaction_id_hmac,email_hmac,email_ciphertext,
            status,asc_stage,created_at,updated_at
          ) VALUES ('alist','pending-rebind','email-b','cipher-b',
            'pending_asc','tester_found',?,?)`,
        ).bind(now, now),
        upgradeDb.prepare(
          `INSERT INTO tf_bindings(
            app_key,app_transaction_id_hmac,email_hmac,email_ciphertext,
            status,asc_stage,created_at,updated_at
          ) VALUES ('alist','active-existing','email-c','cipher-c',
            'active','invited',?,?)`,
        ).bind(now, now),
      ]);
      const rebindBinding = await upgradeDb.prepare(
        "SELECT id FROM tf_bindings WHERE app_transaction_id_hmac='pending-rebind'",
      ).first<{ id: number }>();
      await upgradeDb.prepare(
        `INSERT INTO tf_web_rebind_operations(
          id,app_key,binding_id,app_transaction_id_hmac,from_email_hmac,
          target_email_hmac,target_email_ciphertext,expected_rebind_count,
          stage,next_attempt_at,created_at,updated_at
        ) VALUES ('legacy-rebind','alist',?,'pending-rebind','email-b',
          'email-new','cipher-new',0,'prepared',?,?,?)`,
      ).bind(rebindBinding!.id, now, now, now).run();

      await applyMigrations(upgradeDb, MIGRATIONS.slice(8));

      const operations = await upgradeDb.prepare(
        `SELECT b.app_transaction_id_hmac, o.target_group_id
         FROM tf_access_operations o
         JOIN tf_bindings b ON b.id = o.binding_id
         ORDER BY b.app_transaction_id_hmac`,
      ).all<{ app_transaction_id_hmac: string; target_group_id: string }>();
      expect(operations.results).toEqual([
        {
          app_transaction_id_hmac: "active-existing",
          target_group_id: "16b2ab29-bbde-4291-a4b7-77ee42eefb70",
        },
        {
          app_transaction_id_hmac: "pending-recover",
          target_group_id: "16b2ab29-bbde-4291-a4b7-77ee42eefb70",
        },
      ]);
      const upgradedRebind = await upgradeDb.prepare(
        "SELECT target_group_id FROM tf_web_rebind_operations WHERE id='legacy-rebind'",
      ).first<{ target_group_id: string }>();
      expect(upgradedRebind?.target_group_id).toBe(
        "16b2ab29-bbde-4291-a4b7-77ee42eefb70",
      );
      const groups = await upgradeDb.prepare(
        "SELECT DISTINCT beta_group_id FROM tf_bindings",
      ).all<{ beta_group_id: string }>();
      expect(groups.results).toEqual([
        { beta_group_id: "c7ca74ed-8a19-4c4b-9a81-ad3d4b235081" },
      ]);
    } finally {
      await upgrade.dispose();
    }
  });

  it("按 0001 到 0012 升级并保留历史 migration、换绑次数和恢复状态", async () => {
    const columns = await database.prepare(
      "PRAGMA table_info(tf_feishu_rebind_jobs)",
    ).all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "card_attempt_count",
        "card_failed_terminal",
        "card_lease_owner",
        "card_lease_expires_at",
      ]),
    );
    const eventColumns = await database.prepare(
      "PRAGMA table_info(tf_feishu_events)",
    ).all<{ name: string }>();
    expect(eventColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "app_transaction_id_ciphertext",
        "new_email_ciphertext",
      ]),
    );
    const jobColumns = await database.prepare(
      "PRAGMA table_info(tf_feishu_rebind_jobs)",
    ).all<{ name: string }>();
    expect(jobColumns.results.map((column) => column.name)).toContain(
      "intended_operation",
    );
    const bindingColumns = await database.prepare(
      "PRAGMA table_info(tf_bindings)",
    ).all<{ name: string }>();
    expect(bindingColumns.results.map((column) => column.name)).toContain(
      "rebind_count",
    );
    expect(bindingColumns.results.map((column) => column.name)).toContain(
      "beta_group_id",
    );
    const operationTable = await database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tf_web_rebind_operations'",
    ).first<{ name: string }>();
    expect(operationTable?.name).toBe("tf_web_rebind_operations");
    const accessOperationTable = await database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tf_access_operations'",
    ).first<{ name: string }>();
    expect(accessOperationTable?.name).toBe("tf_access_operations");
  });

  it("将跨 App tester 的 409 终态初绑重置为可恢复任务", async () => {
    const now = Date.now();
    await database.prepare(
      `INSERT INTO tf_bindings(
        app_key, app_transaction_id_hmac, email_hmac, email_ciphertext,
        asc_tester_id, status, asc_stage, beta_group_id, created_at, updated_at
      ) VALUES (
        'alist', 'cross-app-transaction', 'cross-app-email', 'ciphertext',
        'foreign-tester', 'pending_asc', 'tester_found', 'old-group', ?, ?
      )`,
    ).bind(now, now).run();
    const binding = await database.prepare(
      "SELECT id FROM tf_bindings WHERE app_transaction_id_hmac = 'cross-app-transaction'",
    ).first<{ id: number }>();
    await database.prepare(
      `INSERT INTO tf_access_operations(
        id, app_key, binding_id, app_transaction_id_hmac, operation_type,
        target_group_id, tester_id, stage, status, attempt_count, max_attempts,
        next_attempt_at, error_kind, last_error, last_http_status, last_asc_code,
        created_at, updated_at
      ) VALUES (
        '4c0993121743d436b10897dfe3384d1b', 'alist', ?, 'cross-app-transaction', 'apply',
        'purchased-group', 'foreign-tester', 'group_adding', 'failed_terminal',
        1, 8, ?, 'terminal', 'asc_state_error', 409, 'STATE_ERROR', ?, ?
      )`,
    ).bind(binding!.id, now, now, now).run();

    await applyMigrations(database, ["0012_retry_cross_app_tester.sql"]);

    expect(await database.prepare(
      "SELECT asc_tester_id, asc_stage, status FROM tf_bindings WHERE id = ?",
    ).bind(binding!.id).first()).toMatchObject({
      asc_tester_id: null,
      asc_stage: "none",
      status: "pending_asc",
    });
    expect(await database.prepare(
      `SELECT tester_id, stage, status, attempt_count, last_http_status, last_asc_code
       FROM tf_access_operations WHERE id = '4c0993121743d436b10897dfe3384d1b'`,
    ).first()).toMatchObject({
      tester_id: null,
      stage: "tester_adding",
      status: "active",
      attempt_count: 0,
      last_http_status: null,
      last_asc_code: null,
    });
  });

  it("D1 batch 中途失败时原子回滚", async () => {
    await database.exec("CREATE TABLE integration_atomic(id INTEGER PRIMARY KEY);");
    await expect(database.batch([
      database.prepare("INSERT INTO integration_atomic(id) VALUES (1)"),
      database.prepare("INSERT INTO integration_atomic(id) VALUES (1)"),
    ])).rejects.toThrow();
    const row = await database.prepare(
      "SELECT COUNT(*) AS count FROM integration_atomic",
    ).first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("历史绑定回填旧分组，新绑定保存当前目标组快照", async () => {
    const testEnv = Object.assign({} as Env, {
      DB: database,
      APP_KEY: "alist",
      ASC_BETA_GROUP_ID: "current-purchased-group",
    });
    const now = Date.now();
    await database.prepare(
      `INSERT INTO tf_bindings(
        app_key,app_transaction_id_hmac,email_hmac,email_ciphertext,
        status,asc_stage,created_at,updated_at
      ) VALUES ('alist','legacy-transaction','legacy-email','legacy-cipher',
        'active','invited',?,?)`,
    ).bind(now, now).run();
    expect((await findBindingByTransaction(testEnv, "legacy-transaction"))?.beta_group_id)
      .toBe("c7ca74ed-8a19-4c4b-9a81-ad3d4b235081");

    const current = await createBinding(
      testEnv,
      "current-transaction",
      "current-email",
      "current-cipher",
      now,
    );
    expect(current.beta_group_id).toBe("current-purchased-group");
  });

  it("申请与修复任务按 binding 唯一，并通过 CAS 和有限重试恢复", async () => {
    const testEnv = Object.assign({} as Env, {
      DB: database,
      APP_KEY: "alist",
      ASC_BETA_GROUP_ID: "purchased-group",
    });
    const now = Date.now();
    const binding = await createBinding(
      testEnv,
      "access-transaction",
      "access-email",
      "access-cipher",
      now,
    );
    const first = await createAccessOperation(
      testEnv,
      binding,
      "apply",
      "purchased-group",
      now,
    );
    const duplicate = await createAccessOperation(
      testEnv,
      binding,
      "repair",
      "other-group",
      now,
    );
    expect(first.id).toBe(duplicate.id);
    expect(await findActiveAccessOperation(testEnv, binding.id)).toMatchObject({
      target_group_id: "purchased-group",
      stage: "prepared",
      status: "active",
    });
    expect(await compareAndSetAccessOperationStage(
      testEnv,
      first.id,
      "prepared",
      "tester_resolving",
    )).toBe(true);
    expect(await compareAndSetAccessOperationStage(
      testEnv,
      first.id,
      "prepared",
      "tester_found",
    )).toBe(false);

    const failed = await recordAccessOperationFailure(testEnv, first.id, {
      kind: "asc_http",
      safeMessage: "ASC 请求失败",
      httpStatus: 429,
      ascCode: "RATE_LIMITED",
      retryable: true,
      nextAttemptAt: now + 60_000,
    });
    expect(failed).toMatchObject({
      attempt_count: 1,
      status: "active",
      error_kind: "asc_http",
      last_http_status: 429,
      last_asc_code: "RATE_LIMITED",
    });
    expect(await compareAndSetAccessOperationStage(
      testEnv,
      first.id,
      "tester_resolving",
      "tester_found",
      { testerId: "resolved-tester" },
    )).toBe(true);
    expect(await compareAndSetAccessOperationStage(
      testEnv,
      first.id,
      "tester_found",
      "group_visible",
    )).toBe(true);
    expect(await completeAccessOperation(
      testEnv,
      first.id,
      binding.id,
      "resolved-tester",
      "purchased-group",
    )).toBe(true);
    expect(await findActiveAccessOperation(testEnv, binding.id)).toBeNull();
    expect(await findBindingByTransaction(testEnv, "access-transaction")).toMatchObject({
      status: "active",
      asc_tester_id: "resolved-tester",
      beta_group_id: "purchased-group",
    });
  });

  it("破坏性 repair 终态会原子转换为 apply 恢复，不留下崩溃窗口", async () => {
    const testEnv = Object.assign({} as Env, {
      DB: database,
      APP_KEY: "alist",
      ASC_BETA_GROUP_ID: "purchased-group",
    });
    const now = Date.now();
    const binding = await createBinding(
      testEnv,
      "repair-conversion-transaction",
      "repair-conversion-email",
      "repair-conversion-cipher",
      now,
    );
    const operation = await createAccessOperation(
      testEnv,
      binding,
      "repair",
      "purchased-group",
      now,
    );
    await compareAndSetAccessOperationStage(
      testEnv,
      operation.id,
      "prepared",
      "app_removing",
    );
    expect(await convertRepairToApplyRecovery(testEnv, operation.id, {
      kind: "asc_rejected",
      safeMessage: "asc_rejected",
      httpStatus: 422,
      ascCode: "INVALID_RELATIONSHIP",
      nextAttemptAt: now + 60_000,
    })).toBe(true);
    expect(await findActiveAccessOperation(testEnv, binding.id)).toMatchObject({
      operation_type: "apply",
      stage: "tester_adding",
      status: "active",
      attempt_count: 0,
      error_kind: "asc_rejected",
      last_http_status: 422,
      last_asc_code: "INVALID_RELATIONSHIP",
    });
  });

  it("claim 配额原子限制为三份，并绑定创建 IP 且 completed 不会回退", async () => {
    const testEnv = Object.assign({} as Env, { DB: database, APP_KEY: "alist" });
    const now = Date.now();
    const results = await Promise.allSettled(
      ["claim-a", "claim-b", "claim-c", "claim-d"].map((claim) =>
        createClaim(testEnv, claim, "same-transaction", "source-ip", now)
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await findClaim(testEnv, "claim-a"))?.created_ip_hmac).toBe("source-ip");

    await database.prepare(
      "UPDATE tf_claim_sessions SET state='applying' WHERE id_hmac='claim-a'",
    ).run();
    expect(await setClaimState(testEnv, "claim-a", "completed", now + 1)).toBe(true);
    expect(await setClaimState(testEnv, "claim-a", "failed_retryable", now + 2)).toBe(false);
    expect((await findClaim(testEnv, "claim-a"))?.state).toBe("completed");
  });

  it("网页换绑预留目标邮箱，成功后才原子扣减一次机会", async () => {
    const testEnv = Object.assign({} as Env, {
      DB: database,
      APP_KEY: "alist",
      ASC_BETA_GROUP_ID: "new-group",
    });
    const now = Date.now();
    await database.prepare(
      `INSERT INTO tf_bindings(
        app_key,app_transaction_id_hmac,email_hmac,email_ciphertext,
        asc_tester_id,status,asc_stage,created_at,updated_at
      ) VALUES ('alist','transaction-a','old-email','old-cipher','old-tester','active','invited',?,?)`,
    ).bind(now, now).run();
    const binding = await findBindingByTransaction(testEnv, "transaction-a");
    expect(binding?.rebind_count).toBe(0);
    const operation = await createWebRebindOperation(
      testEnv,
      binding!,
      "new-email",
      "new-cipher",
      now,
    );
    expect(operation?.stage).toBe("prepared");

    await expect(
      createBinding(
        testEnv,
        "transaction-b",
        "new-email",
        "other-cipher",
        now,
      ),
    ).rejects.toThrow("binding insert failed");
    expect((await findBindingByTransaction(testEnv, "transaction-a"))?.rebind_count).toBe(0);

    await updateWebRebindStage(testEnv, operation!.id, "new_invited", {
      newTesterId: "new-tester",
      ascStage: "invited",
    });
    const invited = await findActiveWebRebindOperation(testEnv, "transaction-a");
    expect(await completeWebRebind(testEnv, invited!)).toBe(true);
    const rebound = await findBindingByTransaction(testEnv, "transaction-a");
    expect(rebound).toMatchObject({
      email_hmac: "new-email",
      asc_tester_id: "new-tester",
      rebind_count: 1,
    });
    expect(await findActiveWebRebindOperation(testEnv, "transaction-a")).toBeNull();
  });

  it("首次绑定未成功时改用新邮箱不消耗正式换绑次数", async () => {
    const testEnv = Object.assign({} as Env, {
      DB: database,
      APP_KEY: "alist",
      ASC_BETA_GROUP_ID: "new-group",
    });
    const now = Date.now();
    const binding = await createBinding(
      testEnv,
      "pending-email-retry-transaction",
      "failed-first-email",
      "failed-first-cipher",
      now,
    );
    const operation = await createWebRebindOperation(
      testEnv,
      binding,
      "retry-email",
      "retry-cipher",
      now,
    );
    expect(operation?.counts_as_rebind).toBe(0);
    await updateWebRebindStage(testEnv, operation!.id, "new_invited", {
      newTesterId: "retry-tester",
      ascStage: "invited",
    });
    expect(await completeWebRebind(
      testEnv,
      (await findActiveWebRebindOperation(
        testEnv,
        "pending-email-retry-transaction",
      ))!,
    )).toBe(true);
    expect(await findBindingByTransaction(
      testEnv,
      "pending-email-retry-transaction",
    )).toMatchObject({
      email_hmac: "retry-email",
      status: "active",
      rebind_count: 0,
    });
  });

  it("并发换绑同一凭证或同一目标邮箱时只保留一个活动任务", async () => {
    const testEnv = Object.assign({} as Env, {
      DB: database,
      APP_KEY: "alist",
      ASC_BETA_GROUP_ID: "new-group",
    });
    const now = Date.now();
    await database.batch([
      database.prepare(
        `INSERT INTO tf_bindings(
          app_key,app_transaction_id_hmac,email_hmac,email_ciphertext,
          asc_tester_id,status,asc_stage,created_at,updated_at
        ) VALUES ('alist','transaction-a','old-a','cipher-a','tester-a','active','invited',?,?)`,
      ).bind(now, now),
      database.prepare(
        `INSERT INTO tf_bindings(
          app_key,app_transaction_id_hmac,email_hmac,email_ciphertext,
          asc_tester_id,status,asc_stage,created_at,updated_at
        ) VALUES ('alist','transaction-b','old-b','cipher-b','tester-b','active','invited',?,?)`,
      ).bind(now, now),
    ]);
    const [bindingA, bindingB] = await Promise.all([
      findBindingByTransaction(testEnv, "transaction-a"),
      findBindingByTransaction(testEnv, "transaction-b"),
    ]);

    const sameBinding = await Promise.all([
      createWebRebindOperation(testEnv, bindingA!, "target-one", "cipher-one", now),
      createWebRebindOperation(testEnv, bindingA!, "target-two", "cipher-two", now),
    ]);
    expect(new Set(sameBinding.map((operation) => operation?.id)).size).toBe(1);
    const activeA = await findActiveWebRebindOperation(testEnv, "transaction-a");
    expect(activeA).not.toBeNull();

    const competingTarget = activeA!.target_email_hmac;
    const operationB = await createWebRebindOperation(
      testEnv,
      bindingB!,
      competingTarget,
      "cipher-b-target",
      now,
    );
    expect(operationB).toBeNull();
    const activeCount = await database.prepare(
      `SELECT COUNT(*) AS count FROM tf_web_rebind_operations
       WHERE stage NOT IN ('completed','cancelled')`,
    ).first<{count: number}>();
    expect(activeCount?.count).toBe(1);
  });

  it("换绑阶段使用 CAS，破坏性阶段永久失败时转为恢复旧邮箱", async () => {
    const testEnv = Object.assign({} as Env, {
      DB: database,
      APP_KEY: "alist",
      ASC_BETA_GROUP_ID: "new-group",
    });
    const now = Date.now();
    const binding = await createBinding(
      testEnv,
      "compensate-transaction",
      "compensate-old-email",
      "compensate-old-cipher",
      now,
    );
    const operation = await createWebRebindOperation(
      testEnv,
      binding,
      "compensate-new-email",
      "compensate-new-cipher",
      now,
    );
    expect(await compareAndSetWebRebindStage(
      testEnv,
      operation!.id,
      "prepared",
      "old_removing",
    )).toBe(true);
    expect(await compareAndSetWebRebindStage(
      testEnv,
      operation!.id,
      "prepared",
      "old_removed",
    )).toBe(false);

    const failed = await recordWebRebindFailure(testEnv, operation!.id, {
      kind: "asc_rejected",
      safeMessage: "ASC 永久拒绝",
      httpStatus: 422,
      ascCode: "INVALID_RELATIONSHIP",
      retryable: false,
      nextAttemptAt: now + 60_000,
    });
    expect(failed).toMatchObject({
      terminal_state: "active",
      compensation_stage: "old_restoring",
      attempt_count: 1,
      last_http_status: 422,
      last_asc_code: "INVALID_RELATIONSHIP",
    });
    expect(await completeWebRebindCompensation(testEnv, operation!.id)).toBe(true);
    const cancelled = await database.prepare(
      `SELECT terminal_state,compensation_stage,target_email_ciphertext
       FROM tf_web_rebind_operations WHERE id = ?`,
    ).bind(operation!.id).first<{
      terminal_state: string;
      compensation_stage: string;
      target_email_ciphertext: string;
    }>();
    expect(cancelled).toEqual({
      terminal_state: "cancelled",
      compensation_stage: "old_restored",
      target_email_ciphertext: "",
    });
  });

  it("旧邮箱补偿连续失败达到上限后进入终态并清除目标密文", async () => {
    const testEnv = Object.assign({} as Env, {
      DB: database,
      APP_KEY: "alist",
      ASC_BETA_GROUP_ID: "new-group",
    });
    const now = Date.now();
    const binding = await createBinding(
      testEnv,
      "compensation-limit-transaction",
      "compensation-limit-old",
      "old-cipher",
      now,
    );
    const operation = await createWebRebindOperation(
      testEnv,
      binding,
      "compensation-limit-new",
      "new-cipher",
      now,
    );
    await compareAndSetWebRebindStage(
      testEnv,
      operation!.id,
      "prepared",
      "old_removing",
    );
    await recordWebRebindFailure(testEnv, operation!.id, {
      kind: "asc_rejected",
      safeMessage: "asc_rejected",
      retryable: false,
      nextAttemptAt: now,
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await recordWebRebindCompensationFailure(testEnv, operation!.id, {
        kind: "asc_unavailable",
        safeMessage: "asc_unavailable",
        retryable: true,
        nextAttemptAt: now,
      });
    }
    const terminal = await database.prepare(
      `SELECT terminal_state, compensation_stage, compensation_attempt_count,
        target_email_ciphertext
       FROM tf_web_rebind_operations WHERE id = ?`,
    ).bind(operation!.id).first<{
      terminal_state: string;
      compensation_stage: string;
      compensation_attempt_count: number;
      target_email_ciphertext: string;
    }>();
    expect(terminal).toEqual({
      terminal_state: "failed_terminal",
      compensation_stage: "failed_terminal",
      compensation_attempt_count: 8,
      target_email_ciphertext: "",
    });
  });

  it("取消换绑任务时立即清除目标邮箱密文", async () => {
    const testEnv = Object.assign({} as Env, {
      DB: database,
      APP_KEY: "alist",
      ASC_BETA_GROUP_ID: "new-group",
    });
    const now = Date.now();
    await database.prepare(
      `INSERT INTO tf_bindings(
        app_key,app_transaction_id_hmac,email_hmac,email_ciphertext,
        asc_tester_id,status,asc_stage,created_at,updated_at
      ) VALUES ('alist','transaction-c','old-c','old-cipher','old-tester','active','invited',?,?)`,
    ).bind(now, now).run();
    const binding = await findBindingByTransaction(testEnv, "transaction-c");
    const operation = await createWebRebindOperation(
      testEnv,
      binding!,
      "target-c",
      "sensitive-target-cipher",
      now,
    );

    await cancelWebRebindOperation(testEnv, operation!.id);

    const cancelled = await database.prepare(
      "SELECT stage,target_email_ciphertext FROM tf_web_rebind_operations WHERE id = ?",
    ).bind(operation!.id).first<{ stage: string; target_email_ciphertext: string }>();
    expect(cancelled).toEqual({ stage: "cancelled", target_email_ciphertext: "" });
  });

  it("并发消费同一 nonce 只创建一个换绑任务", async () => {
    const now = Date.now();
    await database.batch([
      database.prepare(
        "INSERT INTO tf_feishu_events(event_id,event_type,created_at) VALUES ('source','im.message.receive_v1',?)",
      ).bind(now),
      database.prepare(
        "INSERT INTO tf_feishu_events(event_id,event_type,created_at) VALUES ('action-a','card.action.trigger',?)",
      ).bind(now),
      database.prepare(
        "INSERT INTO tf_feishu_events(event_id,event_type,created_at) VALUES ('action-b','card.action.trigger',?)",
      ).bind(now),
      database.prepare(
        `INSERT INTO tf_feishu_forms(
          nonce_hmac,source_event_id,operator_hmac,message_id,purpose,status,
          expires_at,created_at,updated_at
        ) VALUES ('nonce','source','operator','message','rebind','issued',?,?,?)`,
      ).bind(now + 60_000, now, now),
    ]);

    const consume = (eventId: string) => database.batch([
      database.prepare(
        `UPDATE tf_feishu_forms
         SET status='consumed', consumed_event_id=?, message_id='', updated_at=?
         WHERE nonce_hmac='nonce' AND status='issued' AND expires_at>?`,
      ).bind(eventId, now, now),
      database.prepare(
        `INSERT OR IGNORE INTO tf_feishu_rebind_jobs(
          event_id,form_nonce_hmac,operator_hmac,message_id,
          app_transaction_id_ciphertext,new_email_ciphertext,
          transaction_hmac,email_hmac,operation_status,card_status,
          attempt_count,next_attempt_at,created_at,updated_at
        )
        SELECT ?,'nonce','operator','message','transaction','email',
          'transaction-hmac','email-hmac','pending','pending',0,?,?,?
        WHERE EXISTS(
          SELECT 1 FROM tf_feishu_forms
          WHERE nonce_hmac='nonce' AND status='consumed' AND consumed_event_id=?
        )`,
      ).bind(eventId, now, now, now, eventId),
    ]);

    await Promise.all([consume("action-a"), consume("action-b")]);
    const jobs = await database.prepare(
      "SELECT event_id FROM tf_feishu_rebind_jobs",
    ).all<{ event_id: string }>();
    expect(jobs.results).toHaveLength(1);
  });

  it("existing job、终态和 retention 清理会在真实 D1 中擦除事件敏感字段", async () => {
    const now = Date.now();
    await database.batch([
      database.prepare(
        `INSERT INTO tf_feishu_events(
          event_id,event_type,status,message_id,lease_owner,
          app_transaction_id_ciphertext,new_email_ciphertext,created_at,updated_at
        ) VALUES ('existing','im.message.receive_v1','processing','message','owner',
          'transaction','email',?,?)`,
      ).bind(now, now),
      database.prepare(
        `INSERT INTO tf_feishu_events(
          event_id,event_type,status,message_id,lease_owner,
          app_transaction_id_ciphertext,new_email_ciphertext,created_at,updated_at
        ) VALUES ('terminal','im.message.receive_v1','processing','message','owner',
          'transaction','email',?,?)`,
      ).bind(now, now),
      database.prepare(
        `INSERT INTO tf_feishu_events(
          event_id,event_type,status,message_id,
          app_transaction_id_ciphertext,new_email_ciphertext,created_at,updated_at
        ) VALUES ('retention','im.message.receive_v1','completed','message',
          'transaction','email',?,?)`,
      ).bind(now, now),
    ]);

    await database.prepare(
      `UPDATE tf_feishu_events
       SET app_transaction_id_ciphertext=NULL,
         new_email_ciphertext=NULL, updated_at=?
       WHERE event_id=? AND lease_owner=?`,
    ).bind(now, "existing", "owner").run();
    await database.prepare(
      `UPDATE tf_feishu_events
       SET status='failed_terminal',
         app_transaction_id_ciphertext=CASE WHEN 1 THEN NULL ELSE app_transaction_id_ciphertext END,
         new_email_ciphertext=CASE WHEN 1 THEN NULL ELSE new_email_ciphertext END,
         message_id=CASE WHEN 1 THEN NULL ELSE message_id END
       WHERE event_id=? AND lease_owner=?`,
    ).bind("terminal", "owner").run();
    await database.prepare(
      `UPDATE tf_feishu_events
       SET app_transaction_id_ciphertext=NULL,
         new_email_ciphertext=NULL, message_id=NULL, updated_at=?
       WHERE status IN ('completed','failed_terminal')
         AND (
           app_transaction_id_ciphertext IS NOT NULL
           OR new_email_ciphertext IS NOT NULL
           OR message_id IS NOT NULL
         )`,
    ).bind(now).run();

    const rows = await database.prepare(
      `SELECT event_id,message_id,app_transaction_id_ciphertext,
         new_email_ciphertext
       FROM tf_feishu_events
       WHERE event_id IN ('existing','terminal','retention')
       ORDER BY event_id`,
    ).all<{
      event_id: string;
      message_id: string | null;
      app_transaction_id_ciphertext: string | null;
      new_email_ciphertext: string | null;
    }>();
    expect(rows.results).toEqual([
      {
        event_id: "existing",
        message_id: "message",
        app_transaction_id_ciphertext: null,
        new_email_ciphertext: null,
      },
      {
        event_id: "retention",
        message_id: null,
        app_transaction_id_ciphertext: null,
        new_email_ciphertext: null,
      },
      {
        event_id: "terminal",
        message_id: null,
        app_transaction_id_ciphertext: null,
        new_email_ciphertext: null,
      },
    ]);
  });

  it("并发卡片 claim 只有一个 owner，并能按外键顺序清理", async () => {
    const now = Date.now();
    await seedTerminalJob(database, now);
    const claim = (owner: string) => database.prepare(
      `UPDATE tf_feishu_rebind_jobs
       SET card_lease_owner=?, card_lease_expires_at=?, updated_at=?
       WHERE event_id='action' AND card_status='pending' AND card_failed_terminal=0
         AND (card_lease_owner IS NULL OR card_lease_expires_at<?)`,
    ).bind(owner, now + 60_000, now, now).run();
    const [first, second] = await Promise.all([claim("owner-a"), claim("owner-b")]);
    expect((first.meta.changes ?? 0) + (second.meta.changes ?? 0)).toBe(1);
    const firstOwner = (first.meta.changes ?? 0) === 1 ? "owner-a" : "owner-b";
    const secondOwner = firstOwner === "owner-a" ? "owner-b" : "owner-a";

    await database.prepare(
      "UPDATE tf_feishu_rebind_jobs SET card_lease_expires_at=? WHERE event_id='action'",
    ).bind(now - 1).run();
    const takeover = await claim(secondOwner);
    expect(takeover.meta.changes).toBe(1);

    const staleSuccess = await database.prepare(
      `UPDATE tf_feishu_rebind_jobs
       SET card_status='updated', card_lease_owner=NULL
       WHERE event_id='action' AND card_lease_owner=?`,
    ).bind(firstOwner).run();
    expect(staleSuccess.meta.changes).toBe(0);
    expect(await currentCardState(database)).toMatchObject({
      card_status: "pending",
      card_lease_owner: secondOwner,
    });

    await database.prepare(
      `UPDATE tf_feishu_rebind_jobs
       SET card_status='updated', card_lease_owner=NULL
       WHERE event_id='action' AND card_lease_owner=?`,
    ).bind(secondOwner).run();
    const staleFailure = await database.prepare(
      `UPDATE tf_feishu_rebind_jobs
       SET card_status='pending', card_lease_owner=NULL
       WHERE event_id='action' AND card_lease_owner=?`,
    ).bind(firstOwner).run();
    expect(staleFailure.meta.changes).toBe(0);
    expect(await currentCardState(database)).toMatchObject({
      card_status: "updated",
      card_lease_owner: null,
    });

    await database.batch([
      database.prepare("DELETE FROM tf_feishu_rebind_jobs WHERE event_id='action'"),
      database.prepare("DELETE FROM tf_feishu_forms WHERE nonce_hmac='nonce'"),
      database.prepare("DELETE FROM tf_feishu_events WHERE event_id IN ('source','action')"),
    ]);
    const remaining = await database.prepare(
      "SELECT COUNT(*) AS count FROM tf_feishu_events",
    ).first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });
});

async function currentCardState(database: D1Database): Promise<{
  card_status: string;
  card_lease_owner: string | null;
}> {
  const row = await database.prepare(
    `SELECT card_status, card_lease_owner
     FROM tf_feishu_rebind_jobs WHERE event_id='action'`,
  ).first<{ card_status: string; card_lease_owner: string | null }>();
  if (!row) throw new Error("测试卡片任务不存在");
  return row;
}

async function seedTerminalJob(database: D1Database, now: number): Promise<void> {
  await database.batch([
    database.prepare(
      "INSERT INTO tf_feishu_events(event_id,event_type,created_at) VALUES ('source','im.message.receive_v1',?)",
    ).bind(now),
    database.prepare(
      "INSERT INTO tf_feishu_events(event_id,event_type,created_at) VALUES ('action','card.action.trigger',?)",
    ).bind(now),
    database.prepare(
      `INSERT INTO tf_feishu_forms(
        nonce_hmac,source_event_id,operator_hmac,message_id,purpose,status,
        consumed_event_id,expires_at,created_at,updated_at
      ) VALUES ('nonce','source','operator','','rebind','consumed','action',?,?,?)`,
    ).bind(now, now, now),
    database.prepare(
      `INSERT INTO tf_feishu_rebind_jobs(
        event_id,form_nonce_hmac,operator_hmac,message_id,
        app_transaction_id_ciphertext,new_email_ciphertext,
        transaction_hmac,email_hmac,operation_status,card_status,
        attempt_count,next_attempt_at,created_at,updated_at
      ) VALUES (
        'action','nonce','operator','message','transaction','email',
        'transaction-hmac','email-hmac','succeeded','pending',1,?,?,?
      )`,
    ).bind(now, now, now),
  ]);
}
