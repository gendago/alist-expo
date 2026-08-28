import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyTurnstile: vi.fn(async () => undefined),
  createSession: vi.fn(async () => ({
    applyURL: "https://alistserver.99999987.xyz/tf#claim=test-claim",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  })),
  previewClaim: vi.fn(async () => ({
    operation: "initial_binding",
    remainingRebinds: 2,
    remainingAfter: 2,
    recoveryInProgress: false,
  })),
  applyClaim: vi.fn(async () => ({ status: "invited", remainingRebinds: 2 })),
}));

vi.mock("../src/turnstile", () => ({
  verifyTurnstile: mocks.verifyTurnstile,
}));
vi.mock("../src/service", () => ({
  createSession: mocks.createSession,
  previewClaim: mocks.previewClaim,
  applyClaim: mocks.applyClaim,
  recoverWebRebindWork: vi.fn(async () => ({ recovered: 0, failed: 0 })),
}));
vi.mock("../src/rate-limiter", () => ({
  AListRateLimiter: class {},
  enforceRateLimit: vi.fn(async () => undefined),
}));
vi.mock("../src/secrets", () => ({
  readSecret: vi.fn(async (value: unknown) => String(value)),
}));

import worker from "../src/index";

function env(): Env {
  const statement = {
    bind() { return this; },
    async first() { return null; },
    async run() { return { meta: { changes: 1 } }; },
  };
  return Object.assign({} as Env, {
    APP_KEY: "alist",
    APP_NAME: "AListServer",
    PUBLIC_ORIGIN: "https://alistserver.99999987.xyz",
    IP_HASH_SECRET: "i".repeat(40),
    DB: { prepare: vi.fn(() => statement) },
  });
}

function context(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("公开路由的人机验证顺序", () => {
  it("session 在 Apple 凭证验证前消费 Turnstile", async () => {
    const response = await worker.fetch(
      new Request("https://alistserver.99999987.xyz/api/tf/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.1",
        },
        body: JSON.stringify({
          appTransactionId: "705674173871059076",
          turnstileToken: "turnstile-token",
        }),
      }),
      env(),
      context(),
    );

    expect(response.status).toBe(201);
    expect(mocks.verifyTurnstile).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.verifyTurnstile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createSession.mock.invocationCallOrder[0]!,
    );
  });

  it("preview 和 apply 只依赖短期 claim，不重复消费 Turnstile", async () => {
    const testEnv = env();
    const ctx = context();
    const preview = await worker.fetch(
      new Request("https://alistserver.99999987.xyz/api/tf/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.1",
        },
        body: JSON.stringify({ claimToken: "c".repeat(32), email: "a@example.com" }),
      }),
      testEnv,
      ctx,
    );
    const apply = await worker.fetch(
      new Request("https://alistserver.99999987.xyz/api/tf/apply", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.1",
        },
        body: JSON.stringify({
          claimToken: "c".repeat(32),
          email: "a@example.com",
          confirmRepair: true,
        }),
      }),
      testEnv,
      ctx,
    );

    expect(preview.status).toBe(200);
    expect(apply.status).toBe(200);
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.previewClaim).toHaveBeenCalledTimes(1);
    expect(mocks.applyClaim).toHaveBeenCalledWith(
      testEnv,
      "c".repeat(32),
      "a@example.com",
      false,
      true,
      expect.any(String),
    );
  });
});
