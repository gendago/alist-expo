import { AppError } from "./errors";

export async function readJson<T extends Record<string, unknown>>(
  request: Request,
  maxBytes: number,
): Promise<T> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new AppError("invalid_request", "request body too large", 413);
  }
  if (!request.body) throw new AppError("invalid_request", "missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError("invalid_request", "request body too large", 413);
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
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    return decoded as T;
  } catch {
    throw new AppError("invalid_request", "invalid JSON");
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: securityHeaders("application/json; charset=utf-8"),
  });
}

export function html(body: string, nonce: string): Response {
  return new Response(body, {
    headers: securityHeaders("text/html; charset=utf-8", nonce),
  });
}

function securityHeaders(contentType: string, nonce?: string): Headers {
  const scriptNonce = nonce ? ` 'nonce-${nonce}'` : "";
  return new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy":
      `default-src 'none'; script-src 'self' https://challenges.cloudflare.com${scriptNonce}; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  });
}
