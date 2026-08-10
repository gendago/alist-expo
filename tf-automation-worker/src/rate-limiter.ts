import { DurableObject } from "cloudflare:workers";
import { json, readJson } from "./http";

interface CounterState {
  count: number;
  resetAt: number;
}

export class AListRateLimiter extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ allowed: false }, 405);
    const input = await readJson<Record<string, unknown>>(request, 1024);
    if (
      typeof input.scope !== "string" ||
      typeof input.limit !== "number" ||
      typeof input.windowMs !== "number" ||
      input.scope.length > 160 ||
      input.limit < 1 ||
      input.limit > 100 ||
      input.windowMs < 1_000 ||
      input.windowMs > 86_400_000
    ) {
      return json({ allowed: false }, 400);
    }
    const now = Date.now();
    const key = `counter:${input.scope}`;
    const current = await this.ctx.storage.get<CounterState>(key);
    const next =
      !current || current.resetAt <= now
        ? { count: 1, resetAt: now + input.windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
    await this.ctx.storage.put(key, next);
    return json({
      allowed: next.count <= input.limit,
      retryAfterMs: Math.max(0, next.resetAt - now),
    });
  }
}

export async function enforceRateLimit(
  env: Env,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const id = env.RATE_LIMITER.idFromName(scope);
  const response = await env.RATE_LIMITER.get(id).fetch("https://rate.local/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope, limit, windowMs }),
  });
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("allowed" in result) ||
    result.allowed !== true
  ) {
    throw new (await import("./errors")).AppError(
      "rate_limited",
      "too many requests",
      429,
      true,
    );
  }
}
