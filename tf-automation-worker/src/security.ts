import { AppError } from "./errors";

const encoder = new TextEncoder();
const APP_TRANSACTION_PATTERN = /^[A-Za-z0-9._-]{6,128}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AES_IV_BYTES = 12;

export function normalizeAppTransactionId(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("invalid_request", "invalid credential");
  }
  const normalized = value.trim();
  if (!APP_TRANSACTION_PATTERN.test(normalized)) {
    throw new AppError("invalid_request", "invalid credential");
  }
  return normalized;
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("invalid_request", "invalid email");
  }
  const email = value.trim().toLocaleLowerCase("en-US");
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new AppError("invalid_request", "invalid email");
  }
  return email;
}

export async function hmac(secret: string, value: string): Promise<string> {
  if (encoder.encode(secret).byteLength < 32) {
    throw new Error("HMAC secret is too short");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toHex(new Uint8Array(signature));
}

export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function encryptEmail(
  secret: string,
  appKey: string,
  emailHmac: string,
  email: string,
): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(`alist-tf-email-v1:${appKey}:${emailHmac}`),
      },
      key,
      encoder.encode(email),
    ),
  );
  const bytes = new Uint8Array(1 + iv.length + encrypted.length);
  bytes[0] = 1;
  bytes.set(iv, 1);
  bytes.set(encrypted, 1 + iv.length);
  return base64Url(bytes);
}

export async function decryptEmail(
  secret: string,
  appKey: string,
  emailHmac: string,
  ciphertext: string,
): Promise<string> {
  try {
    const bytes = fromBase64Url(ciphertext);
    if (bytes[0] !== 1 || bytes.length <= 1 + AES_IV_BYTES) throw new Error();
    const key = await aesKey(secret);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(1, 1 + AES_IV_BYTES),
        additionalData: encoder.encode(`alist-tf-email-v1:${appKey}:${emailHmac}`),
      },
      key,
      bytes.slice(1 + AES_IV_BYTES),
    );
    return new TextDecoder().decode(decrypted);
  } catch (cause) {
    throw new Error("stored email cannot be decrypted", { cause });
  }
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const left = await hmac("alist-admin-compare-key-32-bytes-minimum", a);
  const right = await hmac("alist-admin-compare-key-32-bytes-minimum", b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function aesKey(secret: string): Promise<CryptoKey> {
  if (encoder.encode(secret).byteLength < 32) {
    throw new Error("email encryption secret is too short");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`alist-tf-email-key-v1:${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
