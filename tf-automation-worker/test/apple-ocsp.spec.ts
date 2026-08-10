import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  assertOcspResponseIsGood,
  fetchOcspResponse,
  isOcspResponseTimeWindowValid,
  parseOcspResponderResponse,
  parseOcspGeneralizedTime,
} from "../src/apple-ocsp";

function streamingResponse(body: Buffer) {
  const destroy = vi.fn();
  return {
    response: {
      body: {
        destroy,
        async *[Symbol.asyncIterator]() {
          yield body;
        },
      },
      headers: { get: () => null },
      ok: true,
      status: 200,
    },
    destroy,
  };
}

describe("Apple OCSP 传输", () => {
  it("通过 fetch signal 中止挂起请求", async () => {
    let observedSignal: AbortSignal | undefined;
    const hangingFetch = vi.fn(
      (
        _url: string,
        init: { signal?: AbortSignal },
      ): Promise<never> =>
        new Promise((_resolve, reject) => {
          observedSignal = init.signal;
          const rejectForAbort = () => reject(init.signal?.reason);
          if (init.signal?.aborted) {
            rejectForAbort();
            return;
          }
          init.signal?.addEventListener("abort", rejectForAbort, {
            once: true,
          });
        }),
    );

    await expect(
      fetchOcspResponse(
        hangingFetch as never,
        "https://ocsp.apple.test",
        Buffer.from("request"),
        1,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(hangingFetch).toHaveBeenCalledOnce();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("响应流超过 256 KiB 时立即停止并销毁", async () => {
    const { response, destroy } = streamingResponse(
      Buffer.alloc(256 * 1024 + 1),
    );
    const nodeFetch = vi.fn().mockResolvedValue(response);

    await expect(
      fetchOcspResponse(
        nodeFetch as never,
        "https://ocsp.apple.test",
        Buffer.from("request"),
      ),
    ).rejects.toThrow("OCSP response exceeds the size limit");

    expect(destroy).toHaveBeenCalledOnce();
  });

  it("接受恰好达到配置上限的响应", async () => {
    const responseBody = Buffer.from("12345678");
    const { response } = streamingResponse(responseBody);
    const nodeFetch = vi.fn().mockResolvedValue(response);

    await expect(
      fetchOcspResponse(
        nodeFetch as never,
        "https://ocsp.apple.test",
        Buffer.from("request"),
        1_000,
        responseBody.byteLength,
      ),
    ).resolves.toEqual(responseBody);
  });

  it("默认创建 15 秒超时信号", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { response } = streamingResponse(Buffer.from("ocsp"));
    const nodeFetch = vi.fn().mockResolvedValue(response);

    await fetchOcspResponse(
      nodeFetch as never,
      "https://ocsp.apple.test",
      Buffer.from("request"),
    );

    expect(timeout).toHaveBeenCalledWith(15_000);
    timeout.mockRestore();
  });
});

describe("Apple OCSP GeneralizedTime", () => {
  it("严格解析 UTC 秒与可选小数秒", () => {
    expect(parseOcspGeneralizedTime("20260725150000Z")).toBe(
      Date.UTC(2026, 6, 25, 15, 0, 0),
    );
    expect(parseOcspGeneralizedTime("20260725150000.123456Z")).toBe(
      Date.UTC(2026, 6, 25, 15, 0, 0, 123),
    );
  });

  it.each([
    "20260725150000",
    "20260725150000+0000",
    "202607251500Z",
    "20260725150000.Z",
    "20260725150000.120Z",
    "20261325150000Z",
    "20260230150000Z",
    "20260725240000Z",
    "20260725156000Z",
    "20260725150060Z",
    "not-a-date",
  ])("拒绝非 DER 或无效时间 %s", (value) => {
    expect(parseOcspGeneralizedTime(value)).toBeNull();
  });

  it("接受位于时钟偏差范围内的当前响应", () => {
    const now = Date.UTC(2026, 6, 25, 15, 0, 0);

    expect(
      isOcspResponseTimeWindowValid(
        "20260725145900Z",
        "20260725150100Z",
        now,
        60_000,
      ),
    ).toBe(true);
  });

  it("拒绝 thisUpdate 位于未来的响应", () => {
    const now = Date.UTC(2026, 6, 25, 15, 0, 0);

    expect(
      isOcspResponseTimeWindowValid(
        "20260725150101Z",
        "20260725160000Z",
        now,
        60_000,
      ),
    ).toBe(false);
  });

  it("拒绝 nextUpdate 已过期的响应", () => {
    const now = Date.UTC(2026, 6, 25, 15, 0, 0);

    expect(
      isOcspResponseTimeWindowValid(
        "20260725130000Z",
        "20260725145859Z",
        now,
        60_000,
      ),
    ).toBe(false);
  });

  it("对格式错误日期和非法窗口输入保持关闭", () => {
    const now = Date.UTC(2026, 6, 25, 15, 0, 0);

    expect(
      isOcspResponseTimeWindowValid(
        "20260230150000Z",
        "20260725160000Z",
        now,
      ),
    ).toBe(false);
    expect(
      isOcspResponseTimeWindowValid(
        "20260725150000Z",
        "20260725145959Z",
        now,
      ),
    ).toBe(false);
    expect(
      isOcspResponseTimeWindowValid(
        "20260725150000Z",
        "20260725160000Z",
        Number.NaN,
      ),
    ).toBe(false);
  });
});

describe("Apple OCSP responder 结果归类", () => {
  it.each([
    ["解析器抛错", () => {
      throw new Error("invalid ASN.1");
    }],
    ["缺失必要结构", () => ({ alg: "sha256WithRSA" })],
  ])("将 %s 归类为可重试验证失败", async (_name, parse) => {
    const apple = await import("@apple/app-store-server-library");

    try {
      parseOcspResponderResponse(apple, parse, "00");
      throw new Error("预期抛出 VerificationException");
    } catch (error) {
      expect(error).toBeInstanceOf(apple.VerificationException);
      if (error instanceof apple.VerificationException) {
        expect(error.status).toBe(
          apple.VerificationStatus.RETRYABLE_VERIFICATION_FAILURE,
        );
      }
    }
  });

  it("保留解析阶段已有的明确 FAILURE，不误转成可重试", async () => {
    const apple = await import("@apple/app-store-server-library");

    try {
      parseOcspResponderResponse(
        apple,
        () => {
          throw new apple.VerificationException(
            apple.VerificationStatus.FAILURE,
          );
        },
        "00",
      );
      throw new Error("预期抛出 VerificationException");
    } catch (error) {
      expect(error).toBeInstanceOf(apple.VerificationException);
      if (error instanceof apple.VerificationException) {
        expect(error.status).toBe(apple.VerificationStatus.FAILURE);
      }
    }
  });

  it.each(["revoked", "unknown", "bad"])(
    "将明确的 %s 状态判为不可接受，而非可重试",
    async (status) => {
      const apple = await import("@apple/app-store-server-library");

      try {
        assertOcspResponseIsGood(
          apple,
          {
            certid: {
              alg: "sha256",
              issname: "issuer-name",
              isskey: "issuer-key",
              sbjsn: "serial",
            },
            status: { status },
            thisupdate: "20260725145900Z",
            nextupdate: "20260725150100Z",
          },
          Date.UTC(2026, 6, 25, 15, 0, 0),
        );
        throw new Error("预期抛出 VerificationException");
      } catch (error) {
        expect(error).toBeInstanceOf(apple.VerificationException);
        if (error instanceof apple.VerificationException) {
          expect(error.status).toBe(apple.VerificationStatus.FAILURE);
        }
      }
    },
  );

  it("将过期时间窗判为不可接受，而非可重试", async () => {
    const apple = await import("@apple/app-store-server-library");

    try {
      assertOcspResponseIsGood(
        apple,
        {
          certid: {
            alg: "sha256",
            issname: "issuer-name",
            isskey: "issuer-key",
            sbjsn: "serial",
          },
          status: { status: "good" },
          thisupdate: "20260725130000Z",
          nextupdate: "20260725145859Z",
        },
        Date.UTC(2026, 6, 25, 15, 0, 0),
      );
      throw new Error("预期抛出 VerificationException");
    } catch (error) {
      expect(error).toBeInstanceOf(apple.VerificationException);
      if (error instanceof apple.VerificationException) {
        expect(error.status).toBe(apple.VerificationStatus.FAILURE);
      }
    }
  });
});
