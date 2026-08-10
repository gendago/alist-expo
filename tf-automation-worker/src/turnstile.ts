import { AppError } from "./errors";
import { readSecret } from "./secrets";

export async function verifyTurnstile(
  env: Env,
  token: unknown,
  remoteIp: string,
): Promise<void> {
  if (typeof token !== "string" || token.length < 10 || token.length > 2048) {
    throw new AppError("invalid_request", "invalid challenge");
  }
  const secret = await readSecret(env.TURNSTILE_SECRET);
  const body = new URLSearchParams({
    secret,
    response: token,
    remoteip: remoteIp,
  });
  let response: Response;
  try {
    response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body,
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (cause) {
    throw new AppError("temporarily_unavailable", "challenge unavailable", 503, true, { cause });
  }
  const value = await readBoundedTurnstileResponse(response);
  if (!response.ok || !isValidTurnstileResult(
    value,
    new URL(env.PUBLIC_ORIGIN).hostname,
  )) {
    throw new AppError("invalid_request", "challenge failed");
  }
}

export function isValidTurnstileResult(
  value: unknown,
  expectedHostname: string,
): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "success" in value &&
      value.success === true &&
      "hostname" in value &&
      value.hostname === expectedHostname &&
      "action" in value &&
      value.action === "tf_apply",
  );
}

async function readBoundedTurnstileResponse(response: Response): Promise<unknown> {
  const limit = 16 * 1024;
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) throw new AppError("invalid_request", "challenge failed");
  if (!response.body) throw new AppError("invalid_request", "challenge failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AppError("invalid_request", "challenge failed");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError("invalid_request", "challenge failed");
  }
}
