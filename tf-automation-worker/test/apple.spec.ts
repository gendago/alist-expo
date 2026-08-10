import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isRetryableVerificationFailure,
  peekReceiptType,
  queryAndVerifyAppTransaction,
} from "../src/apple";

function unsignedJws(receiptType: string): string {
  const payload = btoa(JSON.stringify({ receiptType }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

describe("App Transaction receiptType 选择", () => {
  it("只允许 Production 与 ProductionVPP 进入正式验签器", () => {
    expect(peekReceiptType(unsignedJws("Production"))).toBe("Production");
    expect(peekReceiptType(unsignedJws("ProductionVPP"))).toBe("ProductionVPP");
    expect(() => peekReceiptType(unsignedJws("Sandbox"))).toThrow();
    expect(() => peekReceiptType(unsignedJws("Xcode"))).toThrow();
  });

  it("Apple OCSP 可重试失败不会被当作无效购买凭证", async () => {
    const apple = await import("@apple/app-store-server-library");
    const error = new apple.VerificationException(
      apple.VerificationStatus.RETRYABLE_VERIFICATION_FAILURE,
    );
    expect(isRetryableVerificationFailure(error, apple)).toBe(true);
    expect(isRetryableVerificationFailure(new Error("invalid"), apple)).toBe(false);
  });
});

const TEST_PRIVATE_KEY = generateKeyPairSync("ec", {
  namedCurve: "P-256",
}).privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function appleEnv(): Env {
  return {
    APPLE_ISSUER_ID: "test-issuer",
    APPLE_KEY_ID: "test-key",
    APPLE_PRIVATE_KEY: TEST_PRIVATE_KEY,
    APP_APPLE_ID: "6502905107",
    BUNDLE_ID: "com.gendago.alist",
  } as unknown as Env;
}

describe("App Transaction API 响应归类", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["缺少 body", () => new Response(null, { status: 200 })],
    ["JSON 无效", () => new Response("not-json", { status: 200 })],
    [
      "响应超过 256 KiB",
      () => new Response(new Uint8Array(256 * 1024 + 1), { status: 200 }),
    ],
  ])("将 Apple 2xx %s 归类为可重试 503", async (_name, createResponse) => {
    vi.stubGlobal("fetch", vi.fn(async () => createResponse()));

    await expect(
      queryAndVerifyAppTransaction(appleEnv(), "app-transaction-123"),
    ).rejects.toMatchObject({
      code: "temporarily_unavailable",
      retryable: true,
      status: 503,
    });
  });

  it.each([400, 404])(
    "仍将 Apple HTTP %s 归类为无效购买凭证",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ error: "not found" }, { status }),
        ),
      );

      await expect(
        queryAndVerifyAppTransaction(appleEnv(), "app-transaction-123"),
      ).rejects.toMatchObject({
        code: "invalid_credential",
        retryable: false,
        status: 400,
      });
    },
  );
});
