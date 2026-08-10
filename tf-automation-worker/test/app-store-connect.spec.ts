import { describe, expect, it } from "vitest";
import {
  assertAscWriteScope,
  isEmptySuccessStatus,
} from "../src/app-store-connect";

describe("App Store Connect 空响应", () => {
  it("撤权的 202/204/404 均按幂等成功处理", () => {
    expect(isEmptySuccessStatus(202)).toBe(true);
    expect(isEmptySuccessStatus(204)).toBe(true);
    expect(isEmptySuccessStatus(404)).toBe(true);
    expect(isEmptySuccessStatus(409)).toBe(false);
  });

  it("bundle 或 group 所属 App 不匹配时在任何写入前失败关闭", () => {
    expect(() =>
      assertAscWriteScope("com.gendago.alist", "alist-app", "alist-group", "other.bundle", "betaGroups", "alist-group", false, "apps", "alist-app"),
    ).toThrow(/scope mismatch/);
    expect(() =>
      assertAscWriteScope("com.gendago.alist", "alist-app", "alist-group", "com.gendago.alist", "betaGroups", "alist-group", false, "apps", "tvbox-app"),
    ).toThrow(/scope mismatch/);
    expect(() =>
      assertAscWriteScope("com.gendago.alist", "alist-app", "alist-group", "com.gendago.alist", "betaGroups", "alist-group", false, "apps", "alist-app"),
    ).not.toThrow();
    expect(() =>
      assertAscWriteScope("com.gendago.alist", "alist-app", "alist-group", "com.gendago.alist", "betaGroups", "alist-group", true, "apps", "alist-app"),
    ).toThrow(/scope mismatch/);
  });
});
