import { describe, expect, it } from "vitest";
import { OPERATION_LEASE_MS } from "../src/repository";

describe("绑定操作租约", () => {
  it("覆盖最坏 ASC 多阶段网络链路并保留余量", () => {
    expect(OPERATION_LEASE_MS).toBeGreaterThanOrEqual(180_000);
  });
});
