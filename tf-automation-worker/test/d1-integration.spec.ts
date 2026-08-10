import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelWebRebindOperation,
  completeWebRebind,
  createBinding,
  createWebRebindOperation,
  findActiveWebRebindOperation,
  findBindingByTransaction,
  updateWebRebindStage,
} from "../src/repository";

let miniflare: Miniflare;
let database: D1Database;

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-07-27",
    d1Databases: { DB: "alist-tf-integration" },
  });
  database = await miniflare.getD1Database("DB");
  for (const name of [
    "0001_alistserver_init.sql",
    "0002_feishu_events.sql",
    "0003_feishu_rebind_jobs.sql",
    "0004_feishu_card_recovery.sql",
    "0005_feishu_card_lease.sql",
    "0006_feishu_direct_binding.sql",
    "0007_feishu_intended_operation.sql",
    "0008_web_rebind_limit.sql",
  ]) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
});

afterEach(async () => {
  await miniflare.dispose();
});

describe("真实 workerd D1 迁移与并发语义", () => {
  it("按 0001 到 0008 升级并保留历史 migration、换绑次数和恢复状态", async () => {
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
    const operationTable = await database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tf_web_rebind_operations'",
    ).first<{ name: string }>();
    expect(operationTable?.name).toBe("tf_web_rebind_operations");
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

  it("网页换绑预留目标邮箱，成功后才原子扣减一次机会", async () => {
    const testEnv = Object.assign({} as Env, {
      DB: database,
      APP_KEY: "alist",
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

  it("并发换绑同一凭证或同一目标邮箱时只保留一个活动任务", async () => {
    const testEnv = Object.assign({} as Env, {
      DB: database,
      APP_KEY: "alist",
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

  it("取消换绑任务时立即清除目标邮箱密文", async () => {
    const testEnv = Object.assign({} as Env, { DB: database, APP_KEY: "alist" });
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
