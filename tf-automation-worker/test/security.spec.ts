import { describe, expect, it } from "vitest";
import {
  decryptEmail,
  encryptEmail,
  normalizeAppTransactionId,
  normalizeEmail,
  randomToken,
} from "../src/security";

describe("安全工具", () => {
  it("规范化邮箱并拒绝非法购买凭证", () => {
    expect(normalizeEmail(" User@Example.COM ")).toBe("user@example.com");
    expect(() => normalizeAppTransactionId("../../secret")).toThrow();
  });

  it("邮箱密文可恢复且不包含明文", async () => {
    const secret = "a".repeat(40);
    const encrypted = await encryptEmail(
      secret,
      "alist",
      "email-hmac",
      "user@example.com",
    );
    expect(encrypted).not.toContain("user");
    await expect(
      decryptEmail(secret, "alist", "email-hmac", encrypted),
    ).resolves.toBe("user@example.com");
  });

  it("claim token 使用 256 bit 随机源", () => {
    expect(randomToken()).toHaveLength(43);
    expect(randomToken()).not.toBe(randomToken());
  });
});
