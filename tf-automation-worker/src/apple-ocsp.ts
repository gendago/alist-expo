import { Buffer } from "node:buffer";
import {
  createHash,
  verify as verifySignature,
  X509Certificate,
} from "node:crypto";
import type { SignedDataVerifier } from "@apple/app-store-server-library";
import { APPLE_ROOT_CERTIFICATES } from "./apple-roots";

const APPLE_REQUEST_TIMEOUT_MS = 15_000;
const OCSP_RESPONSE_MAX_BYTES = 256 * 1024;
const CERTIFICATE_DATE_MAX_SKEW_MS = 60_000;

type AppleServerLibrary =
  typeof import("@apple/app-store-server-library");
type JsrsaSignLibrary = typeof import("jsrsasign");
type NodeFetchFunction = typeof import("node-fetch").default;
type NodeFetchBody = AsyncIterable<Buffer | Uint8Array | string> & {
  destroy(): void;
};
type VerificationEnvironment =
  ConstructorParameters<AppleServerLibrary["SignedDataVerifier"]>[2];

interface OcspCertId {
  alg: string;
  issname: string;
  isskey: string;
  sbjsn: string;
}

export interface ParsedOcspSingleResponse {
  certid: OcspCertId;
  nextupdate: string;
  status: { status: string };
  thisupdate: string;
}

interface ParsedOcspResponse {
  alg: string;
  array: ParsedOcspSingleResponse[];
  certs: string[];
  respid: {
    key?: string;
    name?: { str: string };
  };
  sighex: string;
}

/**
 * 获取并有界读取 OCSP 响应。
 *
 * node-fetch v2 返回 Node Readable，因此这里按块读取，避免 responder
 * 通过缺失或伪造 Content-Length 让 Worker 一次性缓冲任意大小的响应。
 */
export async function fetchOcspResponse(
  nodeFetch: NodeFetchFunction,
  url: string,
  requestBody: Buffer,
  timeoutMs = APPLE_REQUEST_TIMEOUT_MS,
  maxResponseBytes = OCSP_RESPONSE_MAX_BYTES,
): Promise<Buffer> {
  const response = await nodeFetch(url, {
    headers: { "Content-Type": "application/ocsp-request" },
    method: "POST",
    body: requestBody,
    signal: AbortSignal.timeout(timeoutMs),
  });
  // node-fetch v2 的声明在 Workers 的 Web 类型集合下会被解析为
  // ReadableStream，但运行时实际仍是 Node Readable（支持 async iterator
  // 与 destroy）。这是两套环境声明的边界，不改变运行时对象。
  const responseBody = response.body as unknown as NodeFetchBody | null;
  if (!response.ok) {
    responseBody?.destroy();
    throw new Error(`OCSP responder returned HTTP ${response.status}`);
  }

  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maxResponseBytes
  ) {
    responseBody?.destroy();
    throw new Error("OCSP response exceeds the size limit");
  }

  if (!responseBody) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of responseBody) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxResponseBytes) {
      responseBody.destroy();
      throw new Error("OCSP response exceeds the size limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

function checkCertificateDates(
  apple: AppleServerLibrary,
  cert: X509Certificate,
  effectiveDate: Date,
): void {
  if (
    new Date(cert.validFrom).getTime() >
      effectiveDate.getTime() + CERTIFICATE_DATE_MAX_SKEW_MS ||
    new Date(cert.validTo).getTime() <
      effectiveDate.getTime() - CERTIFICATE_DATE_MAX_SKEW_MS
  ) {
    throw new apple.VerificationException(
      apple.VerificationStatus.INVALID_CERTIFICATE,
    );
  }
}

/**
 * 严格解析 RFC 5280/DER GeneralizedTime。
 *
 * OCSP 响应只能使用 UTC 秒格式；小数秒末尾的 0 在 DER 中不是最短编码，
 * 因此也按无效输入拒绝。
 */
export function parseOcspGeneralizedTime(value: string): number | null {
  const match =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d*[1-9]))?Z$/.exec(
      value,
    );
  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const fractionText = match[7] ?? "";
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number((fractionText + "000").slice(0, 3));
  const timestamp = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second ||
    parsed.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }
  return timestamp;
}

export function isOcspResponseTimeWindowValid(
  thisUpdate: string,
  nextUpdate: string,
  nowMs = Date.now(),
  maxSkewMs = CERTIFICATE_DATE_MAX_SKEW_MS,
): boolean {
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(maxSkewMs) ||
    maxSkewMs < 0
  ) {
    return false;
  }

  const thisUpdateMs = parseOcspGeneralizedTime(thisUpdate);
  const nextUpdateMs = parseOcspGeneralizedTime(nextUpdate);
  if (
    thisUpdateMs === null ||
    nextUpdateMs === null ||
    thisUpdateMs > nextUpdateMs
  ) {
    return false;
  }
  return (
    thisUpdateMs <= nowMs + maxSkewMs &&
    nextUpdateMs >= nowMs - maxSkewMs
  );
}

/**
 * 将 responder 的 ASN.1 解析结果收窄为本模块可安全使用的结构。
 * 解析异常或缺字段说明上游返回不可用，不应把购买凭证永久判为无效。
 */
export function parseOcspResponderResponse(
  apple: AppleServerLibrary,
  parse: (responseHex: string) => unknown,
  responseHex: string,
): ParsedOcspResponse {
  try {
    const parsed = parse(responseHex);
    if (
      !isRecord(parsed) ||
      typeof parsed.alg !== "string" ||
      typeof parsed.sighex !== "string" ||
      !Array.isArray(parsed.certs) ||
      !parsed.certs.every((value) => typeof value === "string") ||
      !Array.isArray(parsed.array) ||
      !isRecord(parsed.respid)
    ) {
      throw new Error("invalid OCSP response structure");
    }

    const responderKey = parsed.respid.key;
    const responderName = parsed.respid.name;
    if (
      (typeof responderKey !== "string" || responderKey.length === 0) &&
      (!isRecord(responderName) ||
        typeof responderName.str !== "string" ||
        responderName.str.length === 0)
    ) {
      throw new Error("invalid OCSP responder identity");
    }

    const responses: ParsedOcspSingleResponse[] = [];
    for (const value of parsed.array) {
      if (
        !isRecord(value) ||
        !isRecord(value.certid) ||
        typeof value.certid.alg !== "string" ||
        typeof value.certid.issname !== "string" ||
        typeof value.certid.isskey !== "string" ||
        typeof value.certid.sbjsn !== "string" ||
        !isRecord(value.status) ||
        typeof value.status.status !== "string" ||
        typeof value.thisupdate !== "string" ||
        typeof value.nextupdate !== "string"
      ) {
        throw new Error("invalid OCSP single response structure");
      }
      responses.push({
        certid: {
          alg: value.certid.alg,
          issname: value.certid.issname,
          isskey: value.certid.isskey,
          sbjsn: value.certid.sbjsn,
        },
        status: { status: value.status.status },
        thisupdate: value.thisupdate,
        nextupdate: value.nextupdate,
      });
    }

    return {
      alg: parsed.alg,
      array: responses,
      certs: parsed.certs,
      respid: {
        ...(typeof responderKey === "string" ? { key: responderKey } : {}),
        ...(isRecord(responderName) && typeof responderName.str === "string"
          ? { name: { str: responderName.str } }
          : {}),
      },
      sighex: parsed.sighex,
    };
  } catch (error) {
    if (error instanceof apple.VerificationException) {
      throw error;
    }
    throw new apple.VerificationException(
      apple.VerificationStatus.RETRYABLE_VERIFICATION_FAILURE,
      error instanceof Error ? error : undefined,
    );
  }
}

export function assertOcspResponseIsGood(
  apple: AppleServerLibrary,
  response: ParsedOcspSingleResponse,
  nowMs = Date.now(),
): void {
  if (
    response.status.status !== "good" ||
    !isOcspResponseTimeWindowValid(
      response.thisupdate,
      response.nextupdate,
      nowMs,
    )
  ) {
    throw new apple.VerificationException(
      apple.VerificationStatus.FAILURE,
    );
  }
}

/**
 * 使用官方 SignedDataVerifier 的证书链校验，仅替换其无超时、无响应上限的
 * OCSP 网络实现。OCSP 响应仍需完成 responder 身份、委托证书用途/有效期、
 * 响应签名、目标证书 ID、状态和时间窗的完整校验。
 */
export function createOnlineSignedDataVerifier(
  apple: AppleServerLibrary,
  jsrsasign: JsrsaSignLibrary,
  nodeFetch: NodeFetchFunction,
  environment: VerificationEnvironment,
  bundleId: string,
  appAppleId: number,
): SignedDataVerifier {
  class BoundedOnlineSignedDataVerifier extends apple.SignedDataVerifier {
    protected override async checkOCSPStatus(
      cert: X509Certificate,
      issuer: X509Certificate,
    ): Promise<void> {
      const authorityRex = /^OCSP - URI:(.*)$/m;
      const matchResult = cert.infoAccess
        ? authorityRex.exec(cert.infoAccess)
        : "";
      if (matchResult === null || matchResult.length !== 2) {
        throw new apple.VerificationException(
          apple.VerificationStatus.INVALID_CERTIFICATE,
        );
      }

      const responderUrl = matchResult[1];
      if (!responderUrl) {
        throw new apple.VerificationException(
          apple.VerificationStatus.INVALID_CERTIFICATE,
        );
      }

      const request = new jsrsasign.KJUR.asn1.ocsp.OCSPRequest({
        reqList: [
          {
            issuerCert: issuer.toString(),
            subjectCert: cert.toString(),
            alg: "sha256",
          },
        ],
      });

      let responseBuffer: Buffer;
      try {
        responseBuffer = await fetchOcspResponse(
          nodeFetch,
          responderUrl,
          Buffer.from(request.getEncodedHex(), "hex"),
        );
      } catch (error) {
        throw new apple.VerificationException(
          apple.VerificationStatus.RETRYABLE_VERIFICATION_FAILURE,
          error instanceof Error ? error : undefined,
        );
      }

      try {
        const ocspNamespace = jsrsasign.KJUR.asn1.ocsp as
          typeof jsrsasign.KJUR.asn1.ocsp & {
            OCSPParser: new () => {
              getOCSPResponse(hex: string): {
                alg: string;
                array: Array<{
                  certid: {
                    alg: string;
                    issname: string;
                    isskey: string;
                    sbjsn: string;
                  };
                  nextupdate: string;
                  status: { status: string };
                  thisupdate: string;
                }>;
                certs: string[];
                respid: {
                  key?: string;
                  name?: { str: string };
                };
                sighex: string;
              };
            };
          };
        const parser = new ocspNamespace.OCSPParser();
        const parsedResponse = parseOcspResponderResponse(
          apple,
          (responseHex) => parser.getOCSPResponse(responseHex),
          responseBuffer.toString("hex"),
        );

        const jsrassignX509Issuer = new jsrsasign.X509();
        jsrassignX509Issuer.readCertHex(issuer.raw.toString("hex"));
        const allCerts = [jsrassignX509Issuer];
        for (const certHex of parsedResponse.certs) {
          const parsedCert = new jsrsasign.X509();
          parsedCert.readCertHex(certHex);
          allCerts.push(parsedCert);
        }

        let signingCert: X509Certificate | null = null;
        if (parsedResponse.respid.key) {
          for (const parsedCert of allCerts) {
            const shasum = createHash("sha1");
            shasum.update(Buffer.from(parsedCert.getSPKIValue(), "hex"));
            if (shasum.digest("hex") === parsedResponse.respid.key) {
              signingCert = new X509Certificate(
                Buffer.from(parsedCert.hex, "hex"),
              );
            }
          }
        } else if (parsedResponse.respid.name) {
          for (const parsedCert of allCerts) {
            if (
              parsedCert.getSubject().str === parsedResponse.respid.name.str
            ) {
              signingCert = new X509Certificate(
                Buffer.from(parsedCert.hex, "hex"),
              );
            }
          }
        }
        if (signingCert === null) {
          throw new apple.VerificationException(
            apple.VerificationStatus.FAILURE,
          );
        }

        if (signingCert.raw.equals(issuer.raw)) {
          // 由目标证书的签发者直接签署 OCSP 响应。
        } else if (signingCert.verify(issuer.publicKey)) {
          const signingCertAssign = new jsrsasign.X509();
          signingCertAssign.readCertPEM(signingCert.toString());
          if (
            !signingCertAssign
              .getExtExtKeyUsage()
              .array.includes("ocspSigning")
          ) {
            throw new apple.VerificationException(
              apple.VerificationStatus.INVALID_CERTIFICATE,
            );
          }
          checkCertificateDates(apple, signingCert, new Date());
        } else {
          throw new apple.VerificationException(
            apple.VerificationStatus.INVALID_CERTIFICATE,
          );
        }

        const responseData = jsrsasign.ASN1HEX.getTLVbyList(
          responseBuffer.toString("hex"),
          0,
          [1, 0, 1, 0, 0],
        );
        const shortAlg = parsedResponse.alg.substring(0, 6).toUpperCase();
        if (
          shortAlg !== "SHA256" &&
          shortAlg !== "SHA384" &&
          shortAlg !== "SHA512"
        ) {
          throw new apple.VerificationException(
            apple.VerificationStatus.FAILURE,
          );
        }
        if (
          !verifySignature(
            shortAlg,
            Buffer.from(responseData as string, "hex"),
            signingCert.publicKey,
            Buffer.from(parsedResponse.sighex, "hex"),
          )
        ) {
          throw new apple.VerificationException(
            apple.VerificationStatus.FAILURE,
          );
        }

        for (const singleResponse of parsedResponse.array) {
          const certIdBuilder =
            new jsrsasign.KJUR.asn1.ocsp.CertID() as
              jsrsasign.KJUR.asn1.ocsp.CertID & {
              getParamByCerts(
                issuerCert: string,
                subjectCert: string,
                algorithm: string,
              ): {
                alg: string;
                issname: string;
                isskey: string;
                sbjsn: string;
              };
            };
          const currentCertCertId = certIdBuilder.getParamByCerts(
            issuer.toString(),
            cert.toString(),
            "sha256",
          );
          if (
            !(
              currentCertCertId.alg === singleResponse.certid.alg &&
              currentCertCertId.issname === singleResponse.certid.issname &&
              currentCertCertId.isskey === singleResponse.certid.isskey &&
              currentCertCertId.sbjsn === singleResponse.certid.sbjsn
            )
          ) {
            continue;
          }

          assertOcspResponseIsGood(apple, singleResponse);
          return;
        }
        throw new apple.VerificationException(
          apple.VerificationStatus.FAILURE,
        );
      } catch (error) {
        if (error instanceof apple.VerificationException) {
          throw error;
        }
        // responder 返回的 ASN.1/证书结构无法解析属于上游暂时异常；
        // 明确的 revoked/unknown/bad 状态和过期时间窗已在上方以 FAILURE 拒绝。
        throw new apple.VerificationException(
          apple.VerificationStatus.RETRYABLE_VERIFICATION_FAILURE,
          error instanceof Error ? error : undefined,
        );
      }
    }
  }

  return new BoundedOnlineSignedDataVerifier(
    APPLE_ROOT_CERTIFICATES,
    true,
    environment,
    bundleId,
    appAppleId,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
