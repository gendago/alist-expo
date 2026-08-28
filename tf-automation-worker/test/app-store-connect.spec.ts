import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppStoreConnectClient,
  assertAscWriteScope,
  isEmptySuccessStatus,
} from "../src/app-store-connect";

const ORIGIN = "https://api.appstoreconnect.apple.com";

function client(): AppStoreConnectClient {
  return Reflect.construct(AppStoreConnectClient, [
    "test-token",
    "com.gendago.alist",
  ]) as AppStoreConnectClient;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function relationship(type: string, ids: string[]): Response {
  return json({ data: ids.map((id) => ({ type, id })) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("App Store Connect tester 强幂等", () => {
  it("tester 已在目标组时不再重复 POST", async () => {
    const requests: Array<{ method: string; pathname: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input instanceof URL ? input.href : String(input));
      requests.push({ method: init?.method ?? "GET", pathname: url.pathname });
      expect(url.href.startsWith(ORIGIN)).toBe(true);
      return relationship("betaGroups", ["purchased-group"]);
    }));

    await client().addTesterToGroup("tester-1", "purchased-group");

    expect(requests).toEqual([
      {
        method: "GET",
        pathname: "/v1/betaTesters/tester-1/relationships/betaGroups",
      },
    ]);
  });

  it("加组响应失败但 ASC 实际关系已存在时按成功收敛", async () => {
    let relationshipReads = 0;
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input instanceof URL ? input.href : String(input));
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") {
        return json({ errors: [{ code: "RELATIONSHIP.ALREADY_EXISTS" }] }, 409);
      }
      expect(url.pathname).toBe(
        "/v1/betaTesters/tester-1/relationships/betaGroups",
      );
      relationshipReads += 1;
      return relationship(
        "betaGroups",
        relationshipReads === 1 ? [] : ["purchased-group"],
      );
    }));

    await expect(
      client().addTesterToGroup("tester-1", "purchased-group"),
    ).resolves.toBeUndefined();
    expect(methods).toEqual(["GET", "POST", "GET"]);
  });

  it("撤权响应失败但 ASC 实际 App 关系已消失时按成功收敛", async () => {
    let appRelationshipReads = 0;
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input instanceof URL ? input.href : String(input));
      const method = init?.method ?? "GET";
      methods.push(method);
      if (url.pathname === "/v1/apps/alist-app") {
        return json({
          data: {
            type: "apps",
            id: "alist-app",
            attributes: { bundleId: "com.gendago.alist" },
          },
        });
      }
      if (method === "DELETE") {
        return json({ errors: [{ code: "ENTITY_ERROR" }] }, 409);
      }
      expect(url.pathname).toBe(
        "/v1/betaTesters/tester-1/relationships/apps",
      );
      appRelationshipReads += 1;
      return relationship(
        "apps",
        appRelationshipReads === 1 ? ["alist-app"] : [],
      );
    }));

    await expect(
      client().removeTesterFromApp("tester-1", "alist-app", async () => undefined),
    ).resolves.toBeUndefined();
    expect(methods).toEqual(["GET", "GET", "DELETE", "GET"]);
  });

  it("app scoped 无结果后全局分页查询，并从跨 App 多记录中选择目标 App tester", async () => {
    const listQueries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(input instanceof URL ? input.href : String(input));
      if (url.pathname === "/v1/betaTesters") {
        listQueries.push(url.search);
        if (url.searchParams.has("filter[apps]")) return json({ data: [] });
        if (!url.searchParams.has("cursor")) {
          return json({
            data: [
              {
                type: "betaTesters",
                id: "tester-other-app",
                attributes: { email: "buyer@example.com", state: "INSTALLED" },
              },
            ],
            links: {
              next: `${ORIGIN}/v1/betaTesters?filter%5Bemail%5D=buyer%40example.com&limit=200&cursor=2`,
            },
          });
        }
        return json({
          data: [
            {
              type: "betaTesters",
              id: "tester-alist",
              attributes: { email: "buyer@example.com", state: "INVITED" },
            },
          ],
        });
      }

      const match = url.pathname.match(
        /^\/v1\/betaTesters\/(tester-other-app|tester-alist)\/relationships\/(apps|betaGroups)$/u,
      );
      expect(match).not.toBeNull();
      const testerId = match?.[1];
      const kind = match?.[2];
      if (kind === "apps") {
        return relationship(
          "apps",
          testerId === "tester-alist" ? ["alist-app"] : ["other-app"],
        );
      }
      return relationship(
        "betaGroups",
        testerId === "tester-alist" ? ["purchased-group"] : ["other-group"],
      );
    }));

    const tester = await client().findTester(
      "buyer@example.com",
      "alist-app",
      "purchased-group",
    );

    expect(tester).toEqual({
      id: "tester-alist",
      email: "buyer@example.com",
      state: "INVITED",
      appIds: ["alist-app"],
      groupIds: ["purchased-group"],
    });
    expect(listQueries).toHaveLength(3);
  });
});
