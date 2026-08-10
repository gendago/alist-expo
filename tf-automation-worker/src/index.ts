import { AppError, toPublicError } from "./errors";
import { html, json, readJson } from "./http";
import { enforceRateLimit, AListRateLimiter } from "./rate-limiter";
import { hmac, normalizeAppTransactionId, randomToken } from "./security";
import {
  applyClaim,
  createSession,
  previewClaim,
  recoverWebRebindWork,
} from "./service";
import { verifyTurnstile } from "./turnstile";
import { applicationPage } from "./web";
import { readSecret } from "./secrets";

export { AListRateLimiter };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      assertOrigin(url, env);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({
          ok: true,
          app: env.APP_NAME,
          configured: configurationReady(env),
          autoApply: env.AUTO_APPLY_ENABLED === "true",
          publicSession: env.PUBLIC_SESSION_ENABLED === "true",
        });
      }
      if (request.method === "GET" && url.pathname === "/tf") {
        const nonce = randomToken(18);
        return html(applicationPage(env, nonce), nonce);
      }
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const ipHmac = await hmac(await readSecret(env.IP_HASH_SECRET), `${env.APP_KEY}:ip:${ip}`);
      if (request.method === "POST" && url.pathname === "/api/tf/session") {
        await enforcePublicLimits(env, "session", ipHmac, 8, 60_000);
        const body = await readJson<Record<string, unknown>>(request, 2048);
        const appTransactionId = normalizeAppTransactionId(body.appTransactionId);
        const result = await createSession(env, appTransactionId, ipHmac);
        recordAttempt(ctx, env, requestId, "session", "created", ipHmac);
        return json(result, 201);
      }
      if (request.method === "POST" && url.pathname === "/api/tf/apply") {
        await enforcePublicLimits(env, "apply", ipHmac, 10, 60_000);
        const body = await readJson<Record<string, unknown>>(request, 8192);
        await verifyTurnstile(env, body.turnstileToken, ip);
        if (typeof body.claimToken !== "string") {
          throw new AppError("invalid_request", "invalid claim");
        }
        const result = await applyClaim(
          env,
          body.claimToken,
          body.email,
          body.confirmRebind === true,
        );
        recordAttempt(ctx, env, requestId, "apply", result.status, ipHmac);
        return json(result);
      }
      if (request.method === "POST" && url.pathname === "/api/tf/preview") {
        await enforcePublicLimits(env, "preview", ipHmac, 20, 60_000);
        const body = await readJson<Record<string, unknown>>(request, 4096);
        if (typeof body.claimToken !== "string") {
          throw new AppError("invalid_request", "invalid claim");
        }
        const result = await previewClaim(env, body.claimToken, body.email);
        recordAttempt(ctx, env, requestId, "preview", result.operation, ipHmac);
        return json(result);
      }
      throw new AppError("not_found", "not found", 404);
    } catch (unknownError) {
      const error = toPublicError(unknownError);
      console.log(JSON.stringify({
        level: error.status >= 500 ? "error" : "warn",
        requestId,
        route: url.pathname,
        method: request.method,
        code: error.code,
        retryable: error.retryable,
      }));
      return json(
        {
          code: error.code,
          message: publicMessage(error),
          retryable: error.retryable,
          requestId,
        },
        error.status,
      );
    }
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        if (controller.cron === "*/5 * * * *") {
          const recovery = await recoverWebRebindWork(env);
          await audit(
            env,
            crypto.randomUUID(),
            "cloudflare_cron",
            "web_rebind_recovery",
            recovery.failed > 0 ? "retryable" : "completed",
            null,
            recovery,
          );
          return;
        }
        if (controller.cron !== "17 3 * * *") return;
        let retention: unknown = { status: "not_started" };
        let retentionFailed = false;
        try {
          retention = await runRetention(env);
        } catch (error) {
          retentionFailed = true;
          retention = { status: "failed" };
          console.log(JSON.stringify({
            level: "error",
            source: "cloudflare_cron",
            action: "retention",
            error: error instanceof Error ? error.name : "unknown",
          }));
        }
        let auditFailed = false;
        try {
          await audit(
            env,
            crypto.randomUUID(),
            "cloudflare_cron",
            "retention",
            retentionFailed ? "failed" : "completed",
            null,
            retention,
          );
        } catch (error) {
          auditFailed = true;
          console.log(JSON.stringify({
            level: "error",
            source: "cloudflare_cron",
            action: "retention_audit",
            error: error instanceof Error ? error.name : "unknown",
          }));
        }
        if (retentionFailed || auditFailed) {
          throw new Error("scheduled maintenance failed");
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

async function enforcePublicLimits(
  env: Env,
  action: string,
  ipHmac: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const cooldown = await env.DB.prepare(
    "SELECT blocked_until FROM tf_cooldowns WHERE scope_hmac = ?",
  ).bind(`${action}:${ipHmac}`).first<{ blocked_until: number }>();
  if ((cooldown?.blocked_until ?? 0) > Date.now()) {
    throw new AppError("rate_limited", "too many requests", 429, true);
  }
  try {
    await enforceRateLimit(env, `${env.APP_KEY}:${action}:${ipHmac}`, limit, windowMs);
  } catch (error) {
    await env.DB.prepare(
      `INSERT INTO tf_cooldowns(scope_hmac, blocked_until, reason, updated_at)
       VALUES (?, ?, 'rate_limit', ?)
       ON CONFLICT(scope_hmac) DO UPDATE SET blocked_until = excluded.blocked_until,
         reason = excluded.reason, updated_at = excluded.updated_at`,
    ).bind(`${action}:${ipHmac}`, Date.now() + windowMs, Date.now()).run();
    throw error;
  }
}

async function runRetention(
  env: Env,
): Promise<{
  claims: number;
  attempts: number;
  audits: number;
  cooldowns: number;
  operationLeases: number;
  webRebindOperations: number;
}> {
  const now = Date.now();
  const statements = [
    env.DB.prepare("DELETE FROM tf_claim_sessions WHERE id_hmac IN (SELECT id_hmac FROM tf_claim_sessions WHERE expires_at < ? LIMIT 500)").bind(now - 86_400_000),
    env.DB.prepare("DELETE FROM tf_attempts WHERE id IN (SELECT id FROM tf_attempts WHERE created_at < ? LIMIT 500)").bind(now - 90 * 86_400_000),
    env.DB.prepare("DELETE FROM tf_audit_log WHERE id IN (SELECT id FROM tf_audit_log WHERE created_at < ? LIMIT 500)").bind(now - 400 * 86_400_000),
    env.DB.prepare(
      `DELETE FROM tf_cooldowns
       WHERE scope_hmac IN (
         SELECT scope_hmac FROM tf_cooldowns
         WHERE blocked_until < ? LIMIT 500
       )`,
    ).bind(now - 86_400_000),
    env.DB.prepare(
      `DELETE FROM tf_operation_leases
       WHERE resource_hmac IN (
         SELECT resource_hmac FROM tf_operation_leases
         WHERE expires_at < ? LIMIT 500
       )`,
    ).bind(now - 86_400_000),
    env.DB.prepare(
      `DELETE FROM tf_web_rebind_operations
       WHERE id IN (
         SELECT id FROM tf_web_rebind_operations
         WHERE stage IN ('completed', 'cancelled') AND updated_at < ? LIMIT 500
       )`,
    ).bind(now - 400 * 86_400_000),
  ];
  const [
    claims,
    attempts,
    audits,
    cooldowns,
    operationLeases,
    webRebindOperations,
  ] = await env.DB.batch(statements);
  return {
    claims: claims?.meta.changes ?? 0,
    attempts: attempts?.meta.changes ?? 0,
    audits: audits?.meta.changes ?? 0,
    cooldowns: cooldowns?.meta.changes ?? 0,
    operationLeases: operationLeases?.meta.changes ?? 0,
    webRebindOperations: webRebindOperations?.meta.changes ?? 0,
  };
}

function recordAttempt(
  ctx: ExecutionContext,
  env: Env,
  requestId: string,
  action: string,
  outcome: string,
  ipHmac: string,
): void {
  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO tf_attempts(request_id, app_key, action, outcome, ip_hmac, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(requestId, env.APP_KEY, action, outcome, ipHmac, Date.now()).run(),
  );
}

async function audit(
  env: Env,
  requestId: string,
  actor: string,
  action: string,
  result: string,
  subject: string | null,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tf_audit_log(request_id, app_key, actor, action, subject_hmac, result, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(requestId, env.APP_KEY, actor, action, subject, result, JSON.stringify(details), Date.now()).run();
}

function configurationReady(env: Env): boolean {
  return /^\d+$/.test(env.APP_APPLE_ID) &&
    /^\d+$/.test(env.ASC_APP_ID) &&
    !env.ASC_BETA_GROUP_ID.startsWith("REPLACE_");
}

function assertOrigin(url: URL, env: Env): void {
  const configured = new URL(env.PUBLIC_ORIGIN);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new AppError("not_found", "not found", 404);
  }
  if (url.hostname !== configured.hostname && url.hostname !== "localhost") {
    throw new AppError("not_found", "not found", 404);
  }
}

function publicMessage(error: AppError): string {
  const messages: Record<string, string> = {
    invalid_request: "请求无效，请返回 App 重试。",
    invalid_credential: "无法验证 App Store 购买资格。",
    rate_limited: "请求过于频繁，请稍后再试。",
    email_already_bound: "该邮箱已绑定其他购买资格，请更换邮箱。",
    rebind_confirmation_required: "换绑前需要再次确认。",
    rebind_limit_reached: "该购买凭证的 2 次换绑机会已用完。",
    capacity_full: "当前测试名额已满，请稍后再试。",
    temporarily_unavailable: "服务暂时不可用，请稍后重试。",
    not_found: "页面不存在。",
    unauthorized: "未授权。",
    disabled: "自助申请暂时关闭，请稍后再试。",
  };
  return messages[error.code] ?? "服务暂时不可用。";
}
