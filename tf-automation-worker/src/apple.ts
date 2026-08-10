import { importPKCS8, SignJWT } from "jose";
import { createOnlineSignedDataVerifier } from "./apple-ocsp";
import { AppError } from "./errors";
import { readSecret } from "./secrets";
import { normalizeAppTransactionId } from "./security";

const APPLE_API_ORIGIN = "https://api.storekit.apple.com";
const RESPONSE_LIMIT = 256 * 1024;
const TIMEOUT_MS = 15_000;

export interface VerifiedAppTransaction {
  appTransactionId: string;
  revokedAt: number | null;
}

type AppleServerLibrary =
  typeof import("@apple/app-store-server-library");

export async function queryAndVerifyAppTransaction(
  env: Env,
  submittedId: string,
): Promise<VerifiedAppTransaction> {
  assertProductionConfig(env);
  const credential = normalizeAppTransactionId(submittedId);
  const [issuerId, keyId, privateKey] = await Promise.all([
    readSecret(env.APPLE_ISSUER_ID),
    readSecret(env.APPLE_KEY_ID),
    readSecret(env.APPLE_PRIVATE_KEY),
  ]);
  const token = await createAppleToken(issuerId, keyId, privateKey, env.BUNDLE_ID);
  const url = `${APPLE_API_ORIGIN}/inApps/v1/transactions/appTransactions/${encodeURIComponent(credential)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new AppError("temporarily_unavailable", "Apple verification unavailable", 503, true, { cause });
  }
  if (response.status === 404 || response.status === 400) {
    await discardBounded(response);
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  if (!response.ok) {
    await discardBounded(response);
    throw new AppError("temporarily_unavailable", "Apple verification unavailable", 503, true);
  }
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson(response, RESPONSE_LIMIT);
  } catch (cause) {
    throw new AppError(
      "temporarily_unavailable",
      "Apple verification unavailable",
      503,
      true,
      { cause },
    );
  }
  const signed = body.signedAppTransactionInfo;
  if (typeof signed !== "string" || signed.length < 100 || signed.length > 64 * 1024) {
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  const verified = await verifySignedAppTransaction(env, signed);
  if (verified.appTransactionId !== credential) {
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  return verified;
}

export async function verifySignedAppTransaction(
  env: Env,
  signed: string,
): Promise<VerifiedAppTransaction> {
  assertProductionConfig(env);
  if (signed.length > 64 * 1024) {
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  let apple: AppleServerLibrary;
  let nodeFetch: typeof import("node-fetch").default;
  let jsrsasign: typeof import("jsrsasign");
  try {
    // jsrsasign 加载时会初始化随机池，必须在请求处理阶段动态加载，
    // 不能在 Worker module scope 静态加载。
    [apple, { default: nodeFetch }, jsrsasign] = await Promise.all([
      import("@apple/app-store-server-library"),
      import("node-fetch"),
      import("jsrsasign"),
    ]);
  } catch (cause) {
    throw new AppError(
      "temporarily_unavailable",
      "Apple verification unavailable",
      503,
      true,
      { cause },
    );
  }
  const receiptType = peekReceiptType(signed);
  const verificationEnvironment =
    receiptType as ConstructorParameters<typeof apple.SignedDataVerifier>[2];
  const verifier = createOnlineSignedDataVerifier(
    apple,
    jsrsasign,
    nodeFetch,
    verificationEnvironment,
    env.BUNDLE_ID,
    Number(env.APP_APPLE_ID),
  );
  let decoded: unknown;
  try {
    decoded = await verifier.verifyAndDecodeAppTransaction(signed);
  } catch (cause) {
    if (isRetryableVerificationFailure(cause, apple)) {
      throw new AppError(
        "temporarily_unavailable",
        "Apple verification unavailable",
        503,
        true,
        { cause },
      );
    }
    throw new AppError("invalid_credential", "invalid purchase credential", 400, false, { cause });
  }
  if (!isRecord(decoded)) {
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  const appTransactionId = normalizeAppTransactionId(decoded.appTransactionId);
  if (decoded.bundleId !== env.BUNDLE_ID || decoded.receiptType !== receiptType) {
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  if (String(decoded.appAppleId) !== env.APP_APPLE_ID) {
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
  const revokedAt = optionalAppleDate(decoded.revocationDate);
  return { appTransactionId, revokedAt };
}

export function isRetryableVerificationFailure(
  cause: unknown,
  apple: AppleServerLibrary,
): boolean {
  return (
    cause instanceof apple.VerificationException &&
    cause.status === apple.VerificationStatus.RETRYABLE_VERIFICATION_FAILURE
  );
}

export function peekReceiptType(
  signed: string,
): "Production" | "ProductionVPP" {
  try {
    const parts = signed.split(".");
    if (parts.length !== 3 || !parts[1]) throw new Error();
    const payload = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payload), (character) => character.charCodeAt(0)),
      ),
    );
    if (
      !isRecord(decoded) ||
      (decoded.receiptType !== "Production" &&
        decoded.receiptType !== "ProductionVPP")
    ) {
      throw new Error();
    }
    return decoded.receiptType;
  } catch {
    throw new AppError("invalid_credential", "invalid purchase credential", 400);
  }
}

async function createAppleToken(
  issuerId: string,
  keyId: string,
  privateKey: string,
  bundleId: string,
): Promise<string> {
  const key = await importPKCS8(privateKey.replace(/\\n/g, "\n"), "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ bid: bundleId })
    .setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT" })
    .setIssuer(issuerId)
    .setAudience("appstoreconnect-v1")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(key);
}

function assertProductionConfig(env: Env): void {
  if (
    !/^\d+$/.test(env.APP_APPLE_ID) ||
    env.APP_APPLE_ID.startsWith("REPLACE_") ||
    env.BUNDLE_ID !== "com.gendago.alist"
  ) {
    throw new AppError("temporarily_unavailable", "service not configured", 503, true);
  }
}

function optionalAppleDate(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new AppError("invalid_credential", "invalid purchase credential", 400);
}

async function readBoundedJson(
  response: Response,
  limit: number,
): Promise<Record<string, unknown>> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) throw new Error("Apple response too large");
  if (!response.body) throw new Error("Apple response missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("Apple response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(value)) throw new Error("invalid Apple response");
  return value;
}

async function discardBounded(response: Response): Promise<void> {
  try {
    await readBoundedJson(response, 16 * 1024);
  } catch {
    await response.body?.cancel();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
