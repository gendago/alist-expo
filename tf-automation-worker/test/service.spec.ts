import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  acquired: true,
  leaseHeld: false,
  ensureGate: null as Promise<void> | null,
  releaseEnsure: null as (() => void) | null,
  ensureStarted: null as Promise<void> | null,
  signalEnsureStarted: null as (() => void) | null,
  ensureError: null as Error | null,
  ensureAfterFinalError: null as Error | null,
  createBindingError: null as Error | null,
  accessOperation: null as any,
  operation: null as any,
  binding: null as null | {
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
  },
  emailBinding: null as null | {
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
  },
  claim: {
    id_hmac: "claim-hmac",
    app_transaction_id_hmac: "transaction-hmac",
    state: "issued",
    email_hmac: null as string | null,
    expires_at: Date.now() + 60_000,
    created_ip_hmac: "ip-hmac",
  },
  removeCalls: 0,
}));

vi.mock("../src/apple", () => ({
  queryAndVerifyAppTransaction: vi.fn(async () => ({
    appTransactionId: "app-transaction-123",
    revokedAt: null,
  })),
  verifySignedAppTransaction: vi.fn(async () => ({
    appTransactionId: "app-transaction-123",
    revokedAt: Date.now() - 1000,
  })),
}));

vi.mock("../src/repository", () => ({
  acquireClaim: vi.fn(async () => {
    if (!state.acquired) return false;
    state.acquired = false;
    return true;
  }),
  acquireAccessOperationLease: vi.fn(async () => true),
  acquireWebRebindOperationLease: vi.fn(async () => true),
  cancelAccessOperation: vi.fn(async () => {
    state.accessOperation = null;
  }),
  acquireLease: vi.fn(async () => {
    if (state.leaseHeld) return false;
    state.leaseHeld = true;
    return true;
  }),
  cancelWebRebindOperation: vi.fn(async () => {
    state.operation = null;
  }),
  createBinding: vi.fn(async (_env, transactionHmac, emailHmac, ciphertext) => {
    if (state.createBindingError) throw state.createBindingError;
    state.binding = {
      id: 1,
      app_transaction_id_hmac: transactionHmac,
      email_hmac: emailHmac,
      email_ciphertext: ciphertext,
      asc_tester_id: null,
      status: "pending_asc",
      asc_stage: "binding_created",
      asc_removal_state: "not_requested",
      rebind_count: 0,
      beta_group_id: "group",
    };
    return state.binding;
  }),
  createClaim: vi.fn(async () => undefined),
  createAccessOperation: vi.fn(async (_env, binding, operationType, targetGroupId) => {
    state.accessOperation ??= {
      id: "access-operation-1",
      binding_id: binding.id,
      app_transaction_id_hmac: binding.app_transaction_id_hmac,
      operation_type: operationType,
      target_group_id: targetGroupId,
      tester_id: binding.asc_tester_id,
      stage: "prepared",
      status: "active",
      attempt_count: 0,
      max_attempts: 8,
      next_attempt_at: Date.now(),
      error_kind: null,
      last_error: null,
      last_http_status: null,
      last_asc_code: null,
    };
    return state.accessOperation;
  }),
  compareAndSetAccessOperationStage: vi.fn(async (_env, _id, expected, next, options = {}) => {
    if (!state.accessOperation || state.accessOperation.stage !== expected) return false;
    state.accessOperation.stage = next;
    if (options.testerId) state.accessOperation.tester_id = options.testerId;
    return true;
  }),
  completeAccessOperation: vi.fn(async (_env, _id, _bindingId, testerId, groupId) => {
    if (!state.binding || !state.accessOperation) return false;
    state.binding.asc_tester_id = testerId;
    state.binding.beta_group_id = groupId;
    state.binding.status = "active";
    state.binding.asc_stage = "invited";
    state.accessOperation = null;
    return true;
  }),
  convertRepairToApplyRecovery: vi.fn(async () => {
    if (!state.accessOperation) return false;
    state.accessOperation.operation_type = "apply";
    state.accessOperation.stage = "tester_adding";
    state.accessOperation.attempt_count = 0;
    return true;
  }),
  completeWebRebind: vi.fn(async () => {
    if (!state.binding || !state.operation?.new_tester_id) return false;
    state.binding.email_hmac = state.operation.target_email_hmac;
    state.binding.email_ciphertext = state.operation.target_email_ciphertext;
    state.binding.asc_tester_id = state.operation.new_tester_id;
    state.binding.status = "active";
    state.binding.rebind_count += state.operation.counts_as_rebind ?? 1;
    state.operation = null;
    return true;
  }),
  createWebRebindOperation: vi.fn(async (_env, binding, target, ciphertext) => {
    state.operation ??= {
      id: "operation-1",
      binding_id: binding.id,
      app_transaction_id_hmac: binding.app_transaction_id_hmac,
      from_email_hmac: binding.email_hmac,
      target_email_hmac: target,
      target_email_ciphertext: ciphertext,
      old_tester_id: binding.asc_tester_id,
      new_tester_id: null,
      expected_rebind_count: binding.rebind_count,
      stage: "prepared",
      asc_stage: "none",
      attempt_count: 0,
      next_attempt_at: Date.now(),
      target_group_id: "group",
      terminal_state: "active",
      compensation_stage: "none",
      error_kind: null,
      last_error: null,
      last_http_status: null,
      last_asc_code: null,
      max_attempts: 8,
      compensation_attempt_count: 0,
      max_compensation_attempts: 8,
      counts_as_rebind: binding.status === "active" ? 1 : 0,
    };
    return state.operation;
  }),
  findActiveWebRebindOperation: vi.fn(async () => state.operation),
  findActiveAccessOperation: vi.fn(async () => state.accessOperation),
  findBindingByEmail: vi.fn(async () => state.emailBinding),
  findBindingByTransaction: vi.fn(async () => state.binding),
  findBindingsNeedingAccessRecovery: vi.fn(async () => []),
  findClaim: vi.fn(async () => state.claim),
  findRecoverableWebRebindOperations: vi.fn(async () =>
    state.operation ? [state.operation] : []
  ),
  findRecoverableAccessOperations: vi.fn(async () => []),
  markBindingRevoked: vi.fn(async () => {
    if (state.binding) state.binding.status = "revoked";
  }),
  releaseLease: vi.fn(async () => {
    state.leaseHeld = false;
  }),
  releaseAccessOperationLease: vi.fn(async () => undefined),
  releaseWebRebindOperationLease: vi.fn(async () => undefined),
  recordAccessOperationFailure: vi.fn(async () => state.accessOperation),
  recordWebRebindFailure: vi.fn(async () => state.operation),
  recordWebRebindCompensationFailure: vi.fn(async () => undefined),
  completeWebRebindCompensation: vi.fn(async () => {
    state.operation = null;
    return true;
  }),
  compareAndSetWebRebindStage: vi.fn(async (_env, _id, expected, next, options = {}) => {
    if (!state.operation || state.operation.stage !== expected) return false;
    state.operation.stage = next;
    if (options.newTesterId) state.operation.new_tester_id = options.newTesterId;
    if (options.ascStage) state.operation.asc_stage = options.ascStage;
    return true;
  }),
  renewLease: vi.fn(async () => state.leaseHeld),
  setClaimState: vi.fn(async (_env, _claim, next) => {
    state.claim.state = next;
  }),
  setRemovalState: vi.fn(async (_env, _id, next) => {
    if (state.binding) state.binding.asc_removal_state = next;
  }),
  updateBindingAsc: vi.fn(async (_env, _id, testerId, stage, active, groupId) => {
    if (state.binding) {
      state.binding.asc_tester_id = testerId;
      state.binding.asc_stage = stage;
      if (active) state.binding.status = "active";
      if (groupId) state.binding.beta_group_id = groupId;
    }
  }),
  updateWebRebindStage: vi.fn(async (_env, _id, stage, options = {}) => {
    if (state.operation) {
      state.operation.stage = stage;
      if (options.newTesterId) state.operation.new_tester_id = options.newTesterId;
      if (options.ascStage) state.operation.asc_stage = options.ascStage;
    }
  }),
}));

vi.mock("../src/app-store-connect", () => ({
  AscErrorCause: class extends Error {},
  AppStoreConnectClient: class {
    static async create() {
      return new this();
    }
    async preflightTester() {}
    async findTester(email: string) {
      return {
        id: email === "new@example.com" ? "tester-2" : "tester-1",
        email,
        state: "INVITED",
        appIds: ["123"],
        groupIds: ["group"],
      };
    }
    async getTester(testerId: string) {
      return {
        id: testerId,
        email: "old@example.com",
        state: "INVITED",
        appIds: ["123"],
        groupIds: ["group"],
      };
    }
    async testerHasGroup() { return false; }
    async waitForTesterGroupState() { return true; }
    async waitForTesterAppState() { return true; }
    async removeTesterFromGroup() {}
    async ensureTester(
      email: string,
      _app: string,
      _group: string,
      onStage: (testerId: string, stage: string) => Promise<void>,
      assertOwnership: () => Promise<void>,
    ) {
      const testerId = email === "new@example.com" ? "tester-2" : "tester-1";
      state.signalEnsureStarted?.();
      if (state.ensureGate) await state.ensureGate;
      if (state.ensureError) {
        const error = state.ensureError;
        state.ensureError = null;
        await onStage(testerId, "tester_created");
        throw error;
      }
      await assertOwnership();
      await onStage(testerId, "invited");
      if (state.ensureAfterFinalError) {
        const error = state.ensureAfterFinalError;
        state.ensureAfterFinalError = null;
        throw error;
      }
      return testerId;
    }
    async removeTesterFromApp() {
      state.removeCalls += 1;
    }
    async removeCurrentAppAccess() {
      state.removeCalls += 1;
    }
  },
}));

import {
  applyClaim as applyClaimService,
  previewClaim as previewClaimService,
  recoverWebRebindWork,
  reportRevocation,
} from "../src/service";

function applyClaim(
  testEnv: Env,
  token: string,
  email: string,
  confirmRebind = false,
  confirmRepair = false,
) {
  return applyClaimService(
    testEnv,
    token,
    email,
    confirmRebind,
    confirmRepair,
    "ip-hmac",
  );
}

function previewClaim(testEnv: Env, token: string, email: string) {
  return previewClaimService(testEnv, token, email, "ip-hmac");
}

function env(): Env {
  return Object.assign({} as Env, {
    APP_KEY: "alist",
    APP_NAME: "AListServer",
    AUTO_APPLY_ENABLED: "true",
    ASC_APP_ID: "123",
    ASC_BETA_GROUP_ID: "group",
    TRANSACTION_HASH_SECRET: "t".repeat(40),
    EMAIL_DATA_SECRET: "e".repeat(40),
  });
}

beforeEach(() => {
  state.acquired = true;
  state.leaseHeld = false;
  state.ensureGate = null;
  state.releaseEnsure = null;
  state.ensureStarted = null;
  state.signalEnsureStarted = null;
  state.ensureError = null;
  state.ensureAfterFinalError = null;
  state.createBindingError = null;
  state.operation = null;
  state.accessOperation = null;
  state.binding = null;
  state.emailBinding = null;
  state.claim = {
    id_hmac: "claim-hmac",
    app_transaction_id_hmac: "transaction-hmac",
    state: "issued",
    email_hmac: null,
    expires_at: Date.now() + 60_000,
    created_ip_hmac: "ip-hmac",
  };
  state.removeCalls = 0;
});

describe("核心状态机", () => {
  it("普通同邮箱申请只做幂等对账，显式修复才执行 App 级移除且不扣换绑次数", async () => {
    await expect(
      applyClaim(env(), "a".repeat(32), "old@example.com"),
    ).resolves.toMatchObject({ status: "invited", remainingRebinds: 2 });
    expect(state.removeCalls).toBe(0);

    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    await expect(
      applyClaim(env(), "b".repeat(32), "old@example.com"),
    ).resolves.toMatchObject({ remainingRebinds: 2 });
    expect(state.removeCalls).toBe(0);

    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    await expect(
      applyClaim(env(), "c".repeat(32), "old@example.com", false, true),
    ).resolves.toMatchObject({ status: "repaired", remainingRebinds: 2 });
    expect(state.removeCalls).toBe(1);
    expect(state.binding?.rebind_count).toBe(0);
  });

  it("claim 只能由创建 session 的同一来源继续使用", async () => {
    await expect(
      applyClaimService(
        env(),
        "c".repeat(32),
        "user@example.com",
        false,
        false,
        "another-ip-hmac",
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 403 });
    await expect(
      previewClaimService(
        env(),
        "c".repeat(32),
        "user@example.com",
        "another-ip-hmac",
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 403 });
  });

  it("同一 claim 并发只有一个执行者", async () => {
    const results = await Promise.allSettled([
      applyClaim(env(), "c".repeat(32), "user@example.com"),
      applyClaim(env(), "c".repeat(32), "user@example.com"),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
  });

  it("网页确认后最多成功换绑两次，失败前不提前扣次数", async () => {
    await expect(
      applyClaim(env(), "c".repeat(32), "old@example.com"),
    ).resolves.toMatchObject({ remainingRebinds: 2 });

    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    await expect(
      previewClaim(env(), "d".repeat(32), "new@example.com"),
    ).resolves.toMatchObject({
      operation: "rebind",
      remainingRebinds: 2,
      remainingAfter: 1,
    });
    expect(state.binding?.rebind_count).toBe(0);
    await expect(
      applyClaim(env(), "d".repeat(32), "new@example.com", true),
    ).resolves.toMatchObject({ status: "rebound", remainingRebinds: 1 });

    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    await expect(
      applyClaim(env(), "e".repeat(32), "last@example.com", true),
    ).resolves.toMatchObject({ status: "rebound", remainingRebinds: 0 });

    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    await expect(
      previewClaim(env(), "f".repeat(32), "third@example.com"),
    ).rejects.toMatchObject({ code: "rebind_limit_reached" });
  });

  it("旧资格移除后 ASC 暂时失败，持久化目标并在重试成功时才扣次数", async () => {
    await applyClaim(env(), "c".repeat(32), "old@example.com");
    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    state.ensureError = new Error("ASC temporary");
    await expect(
      applyClaim(env(), "d".repeat(32), "new@example.com", true),
    ).rejects.toThrow("ASC temporary");
    expect(state.binding?.rebind_count).toBe(0);
    expect(state.operation).toMatchObject({
      stage: "new_adding",
      target_email_hmac: expect.any(String),
    });

    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    await expect(
      applyClaim(env(), "e".repeat(32), "new@example.com", true),
    ).resolves.toMatchObject({ status: "rebound", remainingRebinds: 1 });
    expect(state.binding?.rebind_count).toBe(1);
    expect(state.operation).toBeNull();
  });

  it("换绑终态补偿会先清理目标 tester，再恢复旧邮箱且不扣次数", async () => {
    await applyClaim(env(), "c".repeat(32), "old@example.com");
    const binding = state.binding!;
    state.operation = {
      id: "operation-1",
      binding_id: binding.id,
      app_transaction_id_hmac: binding.app_transaction_id_hmac,
      from_email_hmac: binding.email_hmac,
      target_email_hmac: "new-email-hmac",
      target_email_ciphertext: "target-cipher",
      old_tester_id: "tester-1",
      new_tester_id: "tester-2",
      expected_rebind_count: 0,
      stage: "new_adding",
      asc_stage: "invited",
      attempt_count: 8,
      next_attempt_at: Date.now(),
      target_group_id: "group",
      terminal_state: "active",
      compensation_stage: "old_restoring",
      error_kind: "temporarily_unavailable",
      last_error: "temporarily_unavailable",
      last_http_status: 503,
      last_asc_code: null,
      max_attempts: 8,
      compensation_attempt_count: 0,
      max_compensation_attempts: 8,
      counts_as_rebind: 1,
    };

    await recoverWebRebindWork(env());

    expect(state.removeCalls).toBe(1);
    expect(state.operation).toBeNull();
    expect(state.binding).toMatchObject({
      asc_tester_id: "tester-1",
      status: "active",
      rebind_count: 0,
    });
  });

  it("未确认换绑时不获取 claim、不移除旧资格也不扣次数", async () => {
    await applyClaim(env(), "c".repeat(32), "old@example.com");
    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };

    await expect(
      applyClaim(env(), "d".repeat(32), "new@example.com"),
    ).rejects.toMatchObject({code: "rebind_confirmation_required"});
    expect(state.acquired).toBe(true);
    expect(state.removeCalls).toBe(0);
    expect(state.binding?.rebind_count).toBe(0);
    expect(state.operation).toBeNull();
  });

  it("新 tester 已邀请后响应中断，重试最终只扣一次", async () => {
    await applyClaim(env(), "c".repeat(32), "old@example.com");
    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    state.ensureAfterFinalError = new Error("response lost after invite");
    await expect(
      applyClaim(env(), "d".repeat(32), "new@example.com", true),
    ).rejects.toThrow("response lost after invite");
    expect(state.binding?.rebind_count).toBe(0);
    expect(state.operation).toMatchObject({
      stage: "new_adding",
      new_tester_id: "tester-2",
    });

    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    await expect(
      applyClaim(env(), "e".repeat(32), "new@example.com", true),
    ).resolves.toMatchObject({status: "rebound", remainingRebinds: 1});
    expect(state.binding?.rebind_count).toBe(1);
  });

  it("活动换绑恢复期间旧邮箱不能走普通修复重新获得权限", async () => {
    await applyClaim(env(), "c".repeat(32), "old@example.com");
    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    state.ensureError = new Error("new tester temporary failure");
    await expect(
      applyClaim(env(), "d".repeat(32), "new@example.com", true),
    ).rejects.toThrow("new tester temporary failure");
    expect(state.operation).toMatchObject({stage: "new_adding"});
    expect(state.removeCalls).toBe(1);

    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    await expect(
      applyClaim(env(), "e".repeat(32), "old@example.com"),
    ).rejects.toMatchObject({code: "temporarily_unavailable"});
    expect(state.removeCalls).toBe(1);
    expect(state.binding?.rebind_count).toBe(0);
  });

  it("撤权会同时清理绑定 tester 和活动换绑的新 tester", async () => {
    await applyClaim(env(), "c".repeat(32), "old@example.com");
    state.acquired = true;
    state.claim = {
      ...state.claim,
      state: "issued",
      email_hmac: null,
      expires_at: Date.now() + 60_000,
    };
    state.ensureAfterFinalError = new Error("response lost after invite");
    await expect(
      applyClaim(env(), "d".repeat(32), "new@example.com", true),
    ).rejects.toThrow("response lost after invite");
    expect(state.operation).toMatchObject({
      stage: "new_adding",
      new_tester_id: "tester-2",
    });

    await expect(reportRevocation(env(), "j".repeat(256))).resolves.toEqual({
      status: "completed",
    });
    expect(state.binding).toMatchObject({
      status: "revoked",
      asc_removal_state: "completed",
      rebind_count: 0,
      beta_group_id: "group",
    });
    expect(state.operation).toBeNull();
    expect(state.removeCalls).toBe(3);
  });

  it("同一邮箱已绑定另一购买时要求更换邮箱", async () => {
    state.emailBinding = {
      id: 2,
      app_transaction_id_hmac: "another-transaction",
      email_hmac: "other",
      email_ciphertext: "cipher",
      asc_tester_id: "tester-2",
      status: "active",
      asc_stage: "invited",
      asc_removal_state: "not_requested",
      rebind_count: 0,
      beta_group_id: "group",
    };
    await expect(
      applyClaim(env(), "c".repeat(32), "user@example.com"),
    ).rejects.toMatchObject({ code: "email_already_bound" });
  });

  it("重复撤权幂等且不重复移除 App 权限", async () => {
    state.binding = {
      id: 1,
      app_transaction_id_hmac: "transaction-hmac",
      email_hmac: "email-hmac",
      email_ciphertext: "cipher",
      asc_tester_id: "tester-1",
      status: "active",
      asc_stage: "invited",
      asc_removal_state: "not_requested",
      rebind_count: 0,
      beta_group_id: "group",
    };
    await expect(reportRevocation(env(), "j".repeat(256))).resolves.toEqual({
      status: "completed",
    });
    await expect(reportRevocation(env(), "j".repeat(256))).resolves.toEqual({
      status: "completed",
    });
    expect(state.removeCalls).toBe(1);
  });

  it("申请持有绑定租约时撤权先返回可重试，随后能完整撤权", async () => {
    state.ensureStarted = new Promise<void>((resolve) => {
      state.signalEnsureStarted = resolve;
    });
    state.ensureGate = new Promise<void>((resolve) => {
      state.releaseEnsure = resolve;
    });
    const applying = applyClaim(env(), "c".repeat(32), "user@example.com");
    await state.ensureStarted;
    await expect(reportRevocation(env(), "j".repeat(256))).resolves.toEqual({
      status: "retryable",
    });
    state.releaseEnsure?.();
    const applyResult = await applying;
    expect(["invited", "already_invited"]).toContain(applyResult.status);
    await expect(reportRevocation(env(), "j".repeat(256))).resolves.toEqual({
      status: "completed",
    });
    expect(state.binding?.status).toBe("revoked");
    expect(state.removeCalls).toBe(1);
  });

});
