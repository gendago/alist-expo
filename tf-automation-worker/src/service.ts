import { AppStoreConnectClient, AscErrorCause } from "./app-store-connect";
import { queryAndVerifyAppTransaction, verifySignedAppTransaction } from "./apple";
import { AppError } from "./errors";
import {
  acquireClaim,
  acquireAccessOperationLease,
  acquireLease,
  acquireWebRebindOperationLease,
  cancelAccessOperation,
  cancelWebRebindOperation,
  compareAndSetAccessOperationStage,
  compareAndSetWebRebindStage,
  completeAccessOperation,
  completeWebRebind,
  completeWebRebindCompensation,
  convertRepairToApplyRecovery,
  createAccessOperation,
  createBinding,
  createClaim,
  createWebRebindOperation,
  findActiveAccessOperation,
  findActiveWebRebindOperation,
  findBindingByEmail,
  findBindingByTransaction,
  findBindingsNeedingAccessRecovery,
  findClaim,
  findRecoverableAccessOperations,
  findRecoverableWebRebindOperations,
  markBindingRevoked,
  recordAccessOperationFailure,
  recordWebRebindCompensationFailure,
  recordWebRebindFailure,
  releaseAccessOperationLease,
  releaseLease,
  releaseWebRebindOperationLease,
  renewLease,
  setClaimState,
  setRemovalState,
  updateBindingAsc,
  updateWebRebindStage,
} from "./repository";
import type {
  AccessOperationRow,
  AccessOperationStage,
  BindingRow,
  WebRebindOperationRow,
} from "./repository";
import {
  decryptEmail,
  encryptEmail,
  hmac,
  constantTimeEqual,
  normalizeEmail,
  randomToken,
} from "./security";
import { readSecret } from "./secrets";

const MAX_WEB_REBINDS = 2;

export async function createSession(
  env: Env,
  appTransactionId: string,
  ipHmac: string,
): Promise<{ applyURL: string; expiresAt: string }> {
  if (env.PUBLIC_SESSION_ENABLED !== "true") {
    throw new AppError("disabled", "applications are temporarily closed", 503, true);
  }
  const verified = await queryAndVerifyAppTransaction(env, appTransactionId);
  const transactionHmac = await transactionHash(env, verified.appTransactionId);
  if (verified.revokedAt !== null) {
    await revokeKnownBinding(env, transactionHmac, verified.revokedAt, "session");
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  const existing = await findBindingByTransaction(env, transactionHmac);
  if (existing?.status === "revoked") {
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  const token = randomToken();
  const now = Date.now();
  await createClaim(
    env,
    await claimHash(env, token),
    transactionHmac,
    ipHmac,
    now,
  );
  return {
    applyURL: `${env.PUBLIC_ORIGIN}/tf#claim=${encodeURIComponent(token)}`,
    expiresAt: new Date(now + 300_000).toISOString(),
  };
}

export type ClaimPreview = {
  operation: "initial_binding" | "existing_binding" | "rebind";
  remainingRebinds: number;
  remainingAfter: number;
  recoveryInProgress: boolean;
};

export async function previewClaim(
  env: Env,
  claimToken: string,
  rawEmail: unknown,
  ipHmac: string,
): Promise<ClaimPreview> {
  if (claimToken.length < 20 || claimToken.length > 256) {
    throw new AppError("invalid_request", "invalid claim");
  }
  const email = normalizeEmail(rawEmail);
  const [claimHmac, emailHmac] = await Promise.all([
    claimHash(env, claimToken),
    emailHash(env, email),
  ]);
  const claim = await findClaim(env, claimHmac);
  if (!claim || claim.expires_at <= Date.now()) {
    throw new AppError("invalid_request", "claim expired");
  }
  await assertClaimIp(claim.created_ip_hmac, ipHmac);
  if (claim.state === "completed" && claim.email_hmac !== emailHmac) {
    throw new AppError("invalid_request", "claim already consumed");
  }
  if (
    (claim.state === "applying" || claim.state === "bound_pending_asc") &&
    claim.email_hmac !== emailHmac
  ) {
    throw new AppError(
      "temporarily_unavailable",
      "application is already in progress",
      409,
      true,
    );
  }

  const binding = await findBindingByTransaction(
    env,
    claim.app_transaction_id_hmac,
  );
  if (binding?.status === "revoked") {
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  const activeOperation = await findActiveWebRebindOperation(
    env,
    claim.app_transaction_id_hmac,
  );
  if (activeOperation && activeOperation.target_email_hmac !== emailHmac) {
    throw new AppError(
      "temporarily_unavailable",
      "another rebind is being recovered",
      409,
      true,
    );
  }
  const emailBinding = await findBindingByEmail(env, emailHmac);
  if (
    emailBinding &&
    emailBinding.app_transaction_id_hmac !== claim.app_transaction_id_hmac
  ) {
    throw new AppError("email_already_bound", "target email is already bound", 409);
  }
  if (!binding) {
    return {
      operation: "initial_binding",
      remainingRebinds: MAX_WEB_REBINDS,
      remainingAfter: MAX_WEB_REBINDS,
      recoveryInProgress: false,
    };
  }
  const activeAccessOperation = await findActiveAccessOperation(env, binding.id);
  const remaining = remainingRebinds(binding.rebind_count);
  if (!activeOperation && binding.email_hmac === emailHmac) {
    return {
      operation: "existing_binding",
      remainingRebinds: remaining,
      remainingAfter: remaining,
      recoveryInProgress: Boolean(activeAccessOperation),
    };
  }
  if (remaining === 0) {
    throw new AppError("rebind_limit_reached", "rebind limit reached", 409);
  }
  return {
    operation: "rebind",
    remainingRebinds: remaining,
    remainingAfter: remaining - 1,
    recoveryInProgress: Boolean(activeOperation),
  };
}

export async function applyClaim(
  env: Env,
  claimToken: string,
  rawEmail: unknown,
  confirmRebind = false,
  confirmRepair = false,
  ipHmac = "",
): Promise<{
  status: "invited" | "already_invited" | "rebound" | "repaired";
  remainingRebinds: number;
}> {
  if (env.AUTO_APPLY_ENABLED !== "true") {
    throw new AppError("disabled", "automatic invitations are temporarily closed", 503, true);
  }
  if (claimToken.length < 20 || claimToken.length > 256) {
    throw new AppError("invalid_request", "invalid claim");
  }
  const email = normalizeEmail(rawEmail);
  const [claimHmac, emailHmac] = await Promise.all([
    claimHash(env, claimToken),
    emailHash(env, email),
  ]);
  const claim = await findClaim(env, claimHmac);
  const now = Date.now();
  if (!claim || claim.expires_at <= now) {
    throw new AppError("invalid_request", "claim expired");
  }
  await assertClaimIp(claim.created_ip_hmac, ipHmac);
  if (
    !confirmRepair &&
    claim.state === "completed" &&
    claim.email_hmac === emailHmac
  ) {
    const completedBinding = await findBindingByTransaction(
      env,
      claim.app_transaction_id_hmac,
    );
    return {
      status: "already_invited",
      remainingRebinds: remainingRebinds(completedBinding?.rebind_count ?? 0),
    };
  }
  if (claim.state === "completed") {
    throw new AppError("invalid_request", "claim already consumed");
  }
  if (
    (claim.state === "applying" || claim.state === "bound_pending_asc") &&
    claim.email_hmac !== emailHmac
  ) {
    throw new AppError("temporarily_unavailable", "application is already in progress", 409, true);
  }

  let binding = await findBindingByTransaction(env, claim.app_transaction_id_hmac);
  if (binding?.status === "revoked") {
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  const activeOperation = await findActiveWebRebindOperation(
    env,
    claim.app_transaction_id_hmac,
  );
  if (activeOperation && activeOperation.target_email_hmac !== emailHmac) {
    throw new AppError(
      "temporarily_unavailable",
      "another rebind is being recovered",
      409,
      true,
    );
  }
  const activeAccessOperation = binding
    ? await findActiveAccessOperation(env, binding.id)
    : null;
  if (confirmRepair) {
    if (!binding || binding.email_hmac !== emailHmac || activeOperation) {
      throw new AppError(
        "invalid_request",
        "repair requires the currently bound email",
        409,
      );
    }
    if (activeAccessOperation?.operation_type === "apply") {
      throw new AppError(
        "temporarily_unavailable",
        "an application is already being recovered",
        409,
        true,
      );
    }
  } else if (activeAccessOperation?.operation_type === "repair") {
    throw new AppError(
      "temporarily_unavailable",
      "a repair is already being recovered",
      409,
      true,
    );
  }
  if (binding && (activeOperation || binding.email_hmac !== emailHmac)) {
    if (remainingRebinds(binding.rebind_count) === 0) {
      throw new AppError("rebind_limit_reached", "rebind limit reached", 409);
    }
    if (!confirmRebind) {
      throw new AppError(
        "rebind_confirmation_required",
        "rebind confirmation required",
        409,
      );
    }
  }
  const emailBinding = await findBindingByEmail(env, emailHmac);
  if (
    emailBinding &&
    emailBinding.app_transaction_id_hmac !== claim.app_transaction_id_hmac
  ) {
    throw new AppError("email_already_bound", "target email is already bound", 409);
  }
  const acquired = await acquireClaim(env, claimHmac, emailHmac, now);
  if (!acquired && claim.state !== "bound_pending_asc") {
    throw new AppError("temporarily_unavailable", "application is already in progress", 409, true);
  }
  if (!binding) {
    const ciphertext = await encryptEmail(
      await readSecret(env.EMAIL_DATA_SECRET),
      env.APP_KEY,
      emailHmac,
      email,
    );
    try {
      binding = await createBinding(
        env,
        claim.app_transaction_id_hmac,
        emailHmac,
        ciphertext,
        now,
      );
    } catch (cause) {
      binding = await findBindingByTransaction(env, claim.app_transaction_id_hmac);
      if (!binding || binding.email_hmac !== emailHmac) {
        throw new AppError("email_already_bound", "binding conflict", 409, false, { cause });
      }
    }
  }
  await setClaimState(env, claimHmac, "bound_pending_asc", Date.now());
  const owner = crypto.randomUUID();
  const resource = `binding:${binding.app_transaction_id_hmac}`;
  if (!await acquireLease(env, resource, owner, "apply", Date.now())) {
    await setClaimState(env, claimHmac, "failed_retryable", Date.now());
    throw new AppError("temporarily_unavailable", "application is already in progress", 409, true);
  }
  try {
    const assertOwnership = () => renewOrThrow(env, resource, owner);
    let leasedBinding = await findBindingByTransaction(
      env,
      binding.app_transaction_id_hmac,
    );
    if (!leasedBinding || leasedBinding.status === "revoked") {
      throw new AppError("invalid_credential", "invalid purchase credential", 400);
    }
    let didRebind = false;
    const wasActiveBeforeAccess = leasedBinding.status === "active";
    const leasedOperation = await findActiveWebRebindOperation(
      env,
      leasedBinding.app_transaction_id_hmac,
    );
    if (leasedOperation && leasedOperation.target_email_hmac !== emailHmac) {
      throw new AppError(
        "temporarily_unavailable",
        "another rebind is being recovered",
        409,
        true,
      );
    }
    if (leasedOperation || leasedBinding.email_hmac !== emailHmac) {
      if (!confirmRebind) {
        throw new AppError(
          "rebind_confirmation_required",
          "rebind confirmation required",
          409,
        );
      }
      if (remainingRebinds(leasedBinding.rebind_count) === 0) {
        throw new AppError("rebind_limit_reached", "rebind limit reached", 409);
      }
      leasedBinding = await executeWebRebindUnderLease(
        env,
        leasedBinding,
        emailHmac,
        email,
        assertOwnership,
      );
      didRebind = true;
    } else {
      const operationType = confirmRepair ? "repair" : "apply";
      let accessOperation = await findActiveAccessOperation(env, leasedBinding.id);
      if (accessOperation && accessOperation.operation_type !== operationType) {
        throw new AppError(
          "temporarily_unavailable",
          "another access operation is being recovered",
          409,
          true,
        );
      }
      accessOperation ??= await createAccessOperation(
        env,
        leasedBinding,
        operationType,
        env.ASC_BETA_GROUP_ID,
        Date.now(),
      );
      const accessOwner = crypto.randomUUID();
      if (!await acquireAccessOperationLease(env, accessOperation.id, accessOwner, Date.now())) {
        throw new AppError(
          "temporarily_unavailable",
          "access operation is already in progress",
          409,
          true,
        );
      }
      try {
        await executeAccessOperationUnderLease(
          env,
          leasedBinding,
          accessOperation,
          email,
          assertOwnership,
        );
      } finally {
        await releaseAccessOperationLease(env, accessOperation.id, accessOwner);
      }
      const refreshed = await findBindingByTransaction(
        env,
        leasedBinding.app_transaction_id_hmac,
      );
      if (!refreshed) throw new Error("binding disappeared after access operation");
      leasedBinding = refreshed;
    }
    await setClaimState(env, claimHmac, "completed", Date.now());
    return {
      status: confirmRepair
        ? "repaired"
        : didRebind
        ? "rebound"
        : wasActiveBeforeAccess
          ? "already_invited"
          : "invited",
      remainingRebinds: remainingRebinds(leasedBinding.rebind_count),
    };
  } catch (error) {
    await setClaimState(env, claimHmac, "failed_retryable", Date.now());
    throw error;
  } finally {
    await releaseLease(env, resource, owner);
  }
}

function remainingRebinds(rebindCount: number): number {
  return Math.max(0, MAX_WEB_REBINDS - rebindCount);
}

async function executeAccessOperationUnderLease(
  env: Env,
  binding: BindingRow,
  initialOperation: AccessOperationRow,
  email: string,
  assertOwnership: () => Promise<void>,
): Promise<void> {
  const asc = await AppStoreConnectClient.create(env);
  let operation = initialOperation;
  try {
    await asc.preflightTester(email, env.ASC_APP_ID, operation.target_group_id);
    if (operation.stage === "prepared") {
      operation = await advanceAccessOperation(
        env,
        operation,
        operation.operation_type === "repair" ? "app_removing" : "tester_adding",
      );
    }
    if (operation.operation_type === "repair" && operation.stage === "app_removing") {
      const tester = await asc.findTester(
        email,
        env.ASC_APP_ID,
        operation.target_group_id,
      );
      if (tester?.appIds.includes(env.ASC_APP_ID)) {
        await asc.removeTesterFromApp(tester.id, env.ASC_APP_ID, assertOwnership);
        if (!await asc.waitForTesterAppState(tester.id, env.ASC_APP_ID, false)) {
          throw new AppError(
            "temporarily_unavailable",
            "App Store Connect removal is not visible",
            503,
            true,
          );
        }
      }
      operation = await advanceAccessOperation(env, operation, "app_removed", tester?.id);
    }
    if (operation.stage === "app_removed") {
      operation = await advanceAccessOperation(env, operation, "tester_adding");
    }

    let currentStage = operation.stage;
    const testerId = await asc.ensureTester(
      email,
      env.ASC_APP_ID,
      operation.target_group_id,
      async (resolvedTesterId, ascStage) => {
        await assertOwnership();
        const nextStage: AccessOperationStage =
          ascStage === "group_added"
            ? "group_visible"
            : ascStage === "invited"
              ? "invited"
              : "group_adding";
        const latest = await findActiveAccessOperation(env, binding.id);
        if (!latest) return;
        currentStage = latest.stage;
        if (accessStageRank(nextStage) > accessStageRank(currentStage)) {
          await compareAndSetAccessOperationStage(
            env,
            latest.id,
            currentStage,
            nextStage,
            { testerId: resolvedTesterId },
          );
          currentStage = nextStage;
        }
        await updateBindingAsc(
          env,
          binding.id,
          resolvedTesterId,
          ascStage,
          false,
        );
      },
      assertOwnership,
    );

    if (
      binding.beta_group_id &&
      binding.beta_group_id !== operation.target_group_id &&
      await asc.testerHasGroup(testerId, binding.beta_group_id)
    ) {
      await asc.removeTesterFromGroup(
        testerId,
        binding.beta_group_id,
        env.ASC_APP_ID,
        assertOwnership,
      );
      if (!await asc.waitForTesterGroupState(testerId, binding.beta_group_id, false)) {
        throw new AppError(
          "temporarily_unavailable",
          "old TestFlight group removal is not visible",
          503,
          true,
        );
      }
    }
    const latest = await findActiveAccessOperation(env, binding.id);
    if (!latest) {
      const completedBinding = await findBindingByTransaction(
        env,
        binding.app_transaction_id_hmac,
      );
      if (completedBinding?.status === "active") return;
      throw new Error("access operation disappeared");
    }
    if (latest.stage !== "invited") {
      await compareAndSetAccessOperationStage(
        env,
        latest.id,
        latest.stage,
        "invited",
        { testerId },
      );
    }
    if (!await completeAccessOperation(
      env,
      latest.id,
      binding.id,
      testerId,
      operation.target_group_id,
    )) {
      throw new AppError(
        "temporarily_unavailable",
        "access operation completion pending",
        503,
        true,
      );
    }
  } catch (error) {
    const diagnostic = operationFailure(error, initialOperation.attempt_count);
    const destructiveRepair =
      initialOperation.operation_type === "repair" &&
      accessStageRank(operation.stage) >= accessStageRank("app_removing");
    const terminalFailure =
      !diagnostic.retryable ||
      initialOperation.attempt_count + 1 >= initialOperation.max_attempts;
    if (destructiveRepair && terminalFailure) {
      if (!await convertRepairToApplyRecovery(
        env,
        initialOperation.id,
        diagnostic,
      )) {
        throw new Error("repair recovery conversion failed", { cause: error });
      }
      throw error;
    }
    await recordAccessOperationFailure(
      env,
      initialOperation.id,
      diagnostic,
    );
    throw error;
  }
}

async function advanceAccessOperation(
  env: Env,
  operation: AccessOperationRow,
  nextStage: AccessOperationStage,
  testerId?: string,
): Promise<AccessOperationRow> {
  if (accessStageRank(operation.stage) < accessStageRank(nextStage)) {
    await compareAndSetAccessOperationStage(
      env,
      operation.id,
      operation.stage,
      nextStage,
      { testerId },
    );
  }
  const latest = await findActiveAccessOperation(env, operation.binding_id);
  if (!latest) throw new Error("access operation disappeared");
  return latest;
}

function accessStageRank(stage: AccessOperationStage): number {
  return [
    "prepared",
    "tester_resolving",
    "tester_found",
    "app_removing",
    "app_removed",
    "tester_adding",
    "group_adding",
    "group_visible",
    "inviting",
    "invited",
  ].indexOf(stage);
}

async function executeWebRebindUnderLease(
  env: Env,
  binding: BindingRow,
  targetEmailHmac: string,
  targetEmail: string,
  assertOwnership: () => Promise<void>,
): Promise<BindingRow> {
  const conflicting = await findBindingByEmail(env, targetEmailHmac);
  if (conflicting && conflicting.id !== binding.id) {
    throw new AppError("email_already_bound", "target email is already bound", 409);
  }
  let operation = await findActiveWebRebindOperation(
    env,
    binding.app_transaction_id_hmac,
  );
  if (operation && operation.target_email_hmac !== targetEmailHmac) {
    throw new AppError(
      "temporarily_unavailable",
      "another rebind is being recovered",
      409,
      true,
    );
  }
  if (!operation) {
    if (remainingRebinds(binding.rebind_count) === 0) {
      throw new AppError("rebind_limit_reached", "rebind limit reached", 409);
    }
    const ciphertext = await encryptEmail(
      await readSecret(env.EMAIL_DATA_SECRET),
      env.APP_KEY,
      targetEmailHmac,
      targetEmail,
    );
    operation = await createWebRebindOperation(
      env,
      binding,
      targetEmailHmac,
      ciphertext,
      Date.now(),
    );
    if (!operation || operation.target_email_hmac !== targetEmailHmac) {
      throw new AppError("email_already_bound", "target email is reserved", 409);
    }
  }

  const asc = await AppStoreConnectClient.create(env);
  try {
    if (operation.compensation_stage === "old_restoring") {
      await compensateWebRebind(
        env,
        binding,
        operation,
        asc,
        assertOwnership,
      );
      throw new AppError(
        "temporarily_unavailable",
        "rebind was cancelled and the original email was restored",
        409,
      );
    }
    if (operation.stage === "prepared" || operation.stage === "old_removing") {
      await asc.preflightTester(
        targetEmail,
        env.ASC_APP_ID,
        operation.target_group_id,
      );
    }
    if (operation.stage === "prepared") {
      await compareAndSetWebRebindStage(
        env,
        operation.id,
        "prepared",
        "old_removing",
      );
      operation = await requireActiveWebRebind(env, binding.app_transaction_id_hmac);
    }
    if (operation.stage === "old_removing") {
      if (operation.old_tester_id) {
        await asc.removeTesterFromApp(
          operation.old_tester_id,
          env.ASC_APP_ID,
          assertOwnership,
        );
      } else {
        const oldEmail = await decryptEmail(
          await readSecret(env.EMAIL_DATA_SECRET),
          env.APP_KEY,
          binding.email_hmac,
          binding.email_ciphertext,
        );
        await asc.removeCurrentAppAccess(oldEmail, env.ASC_APP_ID, assertOwnership);
      }
      const oldTesterId = operation.old_tester_id ?? binding.asc_tester_id;
      if (
        oldTesterId &&
        !await asc.waitForTesterAppState(oldTesterId, env.ASC_APP_ID, false)
      ) {
        throw new AppError(
          "temporarily_unavailable",
          "old TestFlight access removal is not visible",
          503,
          true,
        );
      }
      await compareAndSetWebRebindStage(
        env,
        operation.id,
        "old_removing",
        "old_removed",
      );
      operation = await requireActiveWebRebind(env, binding.app_transaction_id_hmac);
    }
    if (operation.stage === "old_removed") {
      await compareAndSetWebRebindStage(
        env,
        operation.id,
        "old_removed",
        "new_adding",
      );
      operation = await requireActiveWebRebind(env, binding.app_transaction_id_hmac);
    }
    if (operation.stage === "new_adding") {
      const testerId = await asc.ensureTester(
        targetEmail,
        env.ASC_APP_ID,
        operation.target_group_id,
        async (newTesterId, stage) => {
          await assertOwnership();
          await updateWebRebindStage(env, operation!.id, "new_adding", {
            newTesterId,
            ascStage: stage,
          });
        },
        assertOwnership,
      );
      await compareAndSetWebRebindStage(
        env,
        operation.id,
        "new_adding",
        "new_invited",
        { newTesterId: testerId, ascStage: "invited" },
      );
      operation = await requireActiveWebRebind(env, binding.app_transaction_id_hmac);
    }
    if (operation.stage !== "new_invited" || !await completeWebRebind(env, operation)) {
      throw new AppError(
        "temporarily_unavailable",
        "rebind completion pending",
        503,
        true,
      );
    }
    const completed = await findBindingByTransaction(
      env,
      binding.app_transaction_id_hmac,
    );
    if (!completed || completed.email_hmac !== targetEmailHmac) {
      throw new Error("rebind completion missing");
    }
    return completed;
  } catch (error) {
    const active = await findActiveWebRebindOperation(env, binding.app_transaction_id_hmac);
    if (active?.compensation_stage === "old_restoring") {
      await recordWebRebindCompensationFailure(
        env,
        active.id,
        operationFailure(error, active.compensation_attempt_count),
      );
      throw error;
    }
    if (active) {
      const failed = await recordWebRebindFailure(
        env,
        active.id,
        operationFailure(error, active.attempt_count),
      );
      if (failed?.compensation_stage === "old_restoring") {
        try {
          await compensateWebRebind(
            env,
            binding,
            failed,
            asc,
            assertOwnership,
          );
        } catch (compensationError) {
          await recordWebRebindCompensationFailure(
            env,
            failed.id,
            operationFailure(
              compensationError,
              failed.compensation_attempt_count,
            ),
          );
        }
      }
    }
    throw error;
  }
}

async function compensateWebRebind(
  env: Env,
  binding: BindingRow,
  operation: WebRebindOperationRow,
  asc: AppStoreConnectClient,
  assertOwnership: () => Promise<void>,
): Promise<void> {
  if (operation.stage === "new_adding" || operation.stage === "new_invited") {
    if (
      operation.new_tester_id &&
      operation.new_tester_id !== operation.old_tester_id
    ) {
      await asc.removeTesterFromApp(
        operation.new_tester_id,
        env.ASC_APP_ID,
        assertOwnership,
      );
    } else if (!operation.new_tester_id && operation.target_email_ciphertext) {
      const targetEmail = await decryptEmail(
        await readSecret(env.EMAIL_DATA_SECRET),
        env.APP_KEY,
        operation.target_email_hmac,
        operation.target_email_ciphertext,
      );
      await asc.removeCurrentAppAccess(
        targetEmail,
        env.ASC_APP_ID,
        assertOwnership,
      );
    }
  }
  const oldEmail = await decryptEmail(
    await readSecret(env.EMAIL_DATA_SECRET),
    env.APP_KEY,
    binding.email_hmac,
    binding.email_ciphertext,
  );
  const testerId = await asc.ensureTester(
    oldEmail,
    env.ASC_APP_ID,
    operation.target_group_id,
    async (resolvedTesterId, stage) => {
      await assertOwnership();
      await updateBindingAsc(
        env,
        binding.id,
        resolvedTesterId,
        `rebind_compensation_${stage}`,
        stage === "invited",
        operation.target_group_id,
      );
    },
    assertOwnership,
  );
  await updateBindingAsc(
    env,
    binding.id,
    testerId,
    "rebind_compensated",
    true,
    operation.target_group_id,
  );
  if (!await completeWebRebindCompensation(env, operation.id)) {
    throw new Error("rebind compensation completion pending");
  }
}

async function requireActiveWebRebind(
  env: Env,
  transactionHmac: string,
): Promise<WebRebindOperationRow> {
  const operation = await findActiveWebRebindOperation(env, transactionHmac);
  if (!operation) throw new Error("rebind operation disappeared");
  return operation;
}

export async function recoverWebRebindWork(
  env: Env,
): Promise<{ recovered: number; failed: number }> {
  let recovered = 0;
  let failed = 0;
  const orphanBindings = await findBindingsNeedingAccessRecovery(env);
  for (const binding of orphanBindings) {
    await createAccessOperation(
      env,
      binding,
      "apply",
      env.ASC_BETA_GROUP_ID,
      Date.now(),
    ).catch(() => undefined);
  }
  const accessOperations = await findRecoverableAccessOperations(env, Date.now());
  for (const operation of accessOperations.slice(0, 5)) {
    const owner = crypto.randomUUID();
    const resource = `binding:${operation.app_transaction_id_hmac}`;
    if (!await acquireLease(env, resource, owner, "access_recovery", Date.now())) continue;
    const operationOwner = crypto.randomUUID();
    if (!await acquireAccessOperationLease(env, operation.id, operationOwner, Date.now())) {
      await releaseLease(env, resource, owner);
      continue;
    }
    try {
      const binding = await findBindingByTransaction(env, operation.app_transaction_id_hmac);
      if (!binding) {
        await cancelAccessOperation(env, operation.id);
        failed += 1;
        continue;
      }
      if (binding.status === "revoked") {
        await cancelAccessOperation(env, operation.id);
        recovered += 1;
        continue;
      }
      const email = await decryptEmail(
        await readSecret(env.EMAIL_DATA_SECRET),
        env.APP_KEY,
        binding.email_hmac,
        binding.email_ciphertext,
      );
      await executeAccessOperationUnderLease(
        env,
        binding,
        operation,
        email,
        () => renewOrThrow(env, resource, owner),
      );
      recovered += 1;
    } catch {
      failed += 1;
    } finally {
      await releaseAccessOperationLease(env, operation.id, operationOwner);
      await releaseLease(env, resource, owner);
    }
  }

  const operations = await findRecoverableWebRebindOperations(env, Date.now());
  for (const operation of operations.slice(0, 5)) {
    const owner = crypto.randomUUID();
    const resource = `binding:${operation.app_transaction_id_hmac}`;
    if (!await acquireLease(env, resource, owner, "web_rebind_recovery", Date.now())) {
      continue;
    }
    const operationOwner = crypto.randomUUID();
    if (!await acquireWebRebindOperationLease(
      env,
      operation.id,
      operationOwner,
      Date.now(),
    )) {
      await releaseLease(env, resource, owner);
      continue;
    }
    try {
      const binding = await findBindingByTransaction(
        env,
        operation.app_transaction_id_hmac,
      );
      if (!binding) {
        await updateWebRebindStage(env, operation.id, operation.stage, {
          error: "binding_unavailable",
        });
        failed += 1;
        continue;
      }
      if (binding.status === "revoked") {
        await cleanupRevokedBindingAndOperation(
          env,
          binding,
          operation,
          () => renewOrThrow(env, resource, owner),
        );
        recovered += 1;
        continue;
      }
      const targetEmail = operation.compensation_stage === "old_restoring"
        ? ""
        : await decryptEmail(
          await readSecret(env.EMAIL_DATA_SECRET),
          env.APP_KEY,
          operation.target_email_hmac,
          operation.target_email_ciphertext,
        );
      await executeWebRebindUnderLease(
        env,
        binding,
        operation.target_email_hmac,
        targetEmail,
        () => renewOrThrow(env, resource, owner),
      );
      recovered += 1;
    } catch {
      const stillActive = await findActiveWebRebindOperation(
        env,
        operation.app_transaction_id_hmac,
      );
      if (
        operation.compensation_stage === "old_restoring" &&
        !stillActive
      ) recovered += 1;
      else failed += 1;
    } finally {
      await releaseWebRebindOperationLease(env, operation.id, operationOwner);
      await releaseLease(env, resource, owner);
    }
  }
  return { recovered, failed };
}

export async function reportRevocation(
  env: Env,
  signed: string,
): Promise<{ status: "completed" | "retryable" }> {
  const verified = await verifySignedAppTransaction(env, signed);
  if (verified.revokedAt === null) {
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  const transactionHmac = await transactionHash(env, verified.appTransactionId);
  const binding = await findBindingByTransaction(env, transactionHmac);
  if (!binding) return { status: "completed" };
  const evidenceHmac = await hmac(
    await readSecret(env.TRANSACTION_HASH_SECRET),
    `alist:revocation:${signed}`,
  );
  if (binding.asc_removal_state === "completed") {
    return { status: "completed" };
  }
  const owner = crypto.randomUUID();
  const resource = `binding:${transactionHmac}`;
  if (!await acquireLease(env, resource, owner, "revoke", Date.now())) {
    return { status: "retryable" };
  }
  try {
    const assertOwnership = () => renewOrThrow(env, resource, owner);
    const leasedBinding = await findBindingByTransaction(env, transactionHmac);
    if (!leasedBinding) return { status: "completed" };
    await markBindingRevoked(
      env,
      leasedBinding.id,
      verified.revokedAt,
      evidenceHmac,
    );
    const operation = await findActiveWebRebindOperation(env, transactionHmac);
    await cleanupRevokedBindingAndOperation(
      env,
      leasedBinding,
      operation,
      assertOwnership,
    );
    return { status: "completed" };
  } catch {
    await setRemovalState(env, binding.id, "failed_retryable", "asc_remove_failed");
    return { status: "retryable" };
  } finally {
    await releaseLease(env, resource, owner);
  }
}

async function revokeKnownBinding(
  env: Env,
  transactionHmac: string,
  revokedAt: number,
  source: string,
): Promise<void> {
  const binding = await findBindingByTransaction(env, transactionHmac);
  if (!binding) return;
  const evidence = await hmac(
    await readSecret(env.TRANSACTION_HASH_SECRET),
    `alist:${source}:${transactionHmac}:${revokedAt}`,
  );
  if (binding.asc_removal_state === "completed") return;
  const owner = crypto.randomUUID();
  const resource = `binding:${transactionHmac}`;
  if (!await acquireLease(env, resource, owner, "revoke", Date.now())) return;
  try {
    const assertOwnership = () => renewOrThrow(env, resource, owner);
    const leasedBinding = await findBindingByTransaction(env, transactionHmac);
    if (!leasedBinding) return;
    await markBindingRevoked(env, leasedBinding.id, revokedAt, evidence);
    const operation = await findActiveWebRebindOperation(env, transactionHmac);
    await cleanupRevokedBindingAndOperation(
      env,
      leasedBinding,
      operation,
      assertOwnership,
    );
  } catch {
    await setRemovalState(env, binding.id, "failed_retryable", "asc_remove_failed");
  } finally {
    await releaseLease(env, resource, owner);
  }
}

async function cleanupRevokedBindingAndOperation(
  env: Env,
  binding: BindingRow,
  operation: WebRebindOperationRow | null,
  assertOwnership: () => Promise<void>,
): Promise<void> {
  const asc = await AppStoreConnectClient.create(env);
  if (binding.asc_removal_state !== "completed") {
    if (binding.asc_tester_id) {
      await asc.removeTesterFromApp(
        binding.asc_tester_id,
        env.ASC_APP_ID,
        assertOwnership,
      );
    } else {
      const email = await decryptEmail(
        await readSecret(env.EMAIL_DATA_SECRET),
        env.APP_KEY,
        binding.email_hmac,
        binding.email_ciphertext,
      );
      await asc.removeCurrentAppAccess(email, env.ASC_APP_ID, assertOwnership);
    }
  }
  if (
    operation &&
    (operation.stage === "new_adding" || operation.stage === "new_invited")
  ) {
    if (
      operation.new_tester_id &&
      operation.new_tester_id !== binding.asc_tester_id
    ) {
      await asc.removeTesterFromApp(
        operation.new_tester_id,
        env.ASC_APP_ID,
        assertOwnership,
      );
    } else if (!operation.new_tester_id) {
      const targetEmail = await decryptEmail(
        await readSecret(env.EMAIL_DATA_SECRET),
        env.APP_KEY,
        operation.target_email_hmac,
        operation.target_email_ciphertext,
      );
      await asc.removeCurrentAppAccess(
        targetEmail,
        env.ASC_APP_ID,
        assertOwnership,
      );
    }
  }
  await setRemovalState(env, binding.id, "completed", null);
  if (operation) await cancelWebRebindOperation(env, operation.id);
}

async function transactionHash(env: Env, value: string): Promise<string> {
  return hmac(await readSecret(env.TRANSACTION_HASH_SECRET), `${env.APP_KEY}:app-transaction:${value}`);
}

async function claimHash(env: Env, value: string): Promise<string> {
  return hmac(await readSecret(env.TRANSACTION_HASH_SECRET), `${env.APP_KEY}:claim:${value}`);
}

async function emailHash(env: Env, value: string): Promise<string> {
  return hmac(await readSecret(env.TRANSACTION_HASH_SECRET), `${env.APP_KEY}:email:${value}`);
}

function operationFailure(
  error: unknown,
  attemptCount: number,
): {
  kind: string;
  safeMessage: string;
  httpStatus?: number;
  ascCode?: string;
  retryable: boolean;
  nextAttemptAt: number;
} {
  const appError = error instanceof AppError ? error : null;
  const cause = appError?.cause instanceof AscErrorCause ? appError.cause : null;
  const delay = Math.min(3_600_000, 60_000 * 2 ** Math.min(attemptCount, 5));
  return {
    kind: appError?.code ?? "unexpected_error",
    safeMessage: appError?.code ?? "unexpected_error",
    ...(cause?.httpStatus === null || cause?.httpStatus === undefined
      ? {}
      : { httpStatus: cause.httpStatus }),
    ...(cause?.ascCode ? { ascCode: cause.ascCode } : {}),
    retryable: appError?.retryable ?? true,
    nextAttemptAt: Date.now() + delay,
  };
}

async function assertClaimIp(expected: string, actual: string): Promise<void> {
  if (!actual || !await constantTimeEqual(expected, actual)) {
    throw new AppError("invalid_request", "claim origin mismatch", 403);
  }
}

async function renewOrThrow(
  env: Env,
  resource: string,
  owner: string,
): Promise<void> {
  if (!await renewLease(env, resource, owner, Date.now())) {
    throw new AppError(
      "temporarily_unavailable",
      "binding operation lease was lost",
      409,
      true,
    );
  }
}
