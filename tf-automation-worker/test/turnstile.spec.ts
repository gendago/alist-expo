import { describe, expect, it } from "vitest";
import { isValidTurnstileResult } from "../src/turnstile";

describe("Turnstile 响应绑定", () => {
  it("同时绑定 hostname 与 action", () => {
    expect(isValidTurnstileResult({
      success: true,
      hostname: "alistserver.99999987.xyz",
      action: "tf_apply",
    }, "alistserver.99999987.xyz")).toBe(true);
    expect(isValidTurnstileResult({
      success: true,
      hostname: "evil.example",
      action: "tf_apply",
    }, "alistserver.99999987.xyz")).toBe(false);
    expect(isValidTurnstileResult({
      success: true,
      hostname: "alistserver.99999987.xyz",
      action: "other",
    }, "alistserver.99999987.xyz")).toBe(false);
  });
});
