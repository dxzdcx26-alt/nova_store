import { createHash, createHmac } from "node:crypto";

export const MAX_SLIP_BYTES = 5 * 1024 * 1024;
const MONEY_PATTERN = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

export function parseMoney(value: unknown): { cents: number; decimal: string } | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = MONEY_PATTERN.exec(String(value).trim());
  if (!match) return null;

  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;

  return {
    cents,
    decimal: `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`,
  };
}

export function detectSlipMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashVoucher(value: string): string {
  return keyedHash("voucher", value);
}

export function hashPhone(value: string): string {
  return keyedHash("phone", value);
}

function keyedHash(purpose: string, value: string): string {
  const secret = process.env.XNEARBY_DATA_HASH_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("XNEARBY_DATA_HASH_KEY must contain at least 32 characters");
  }
  return createHmac("sha256", secret)
    .update(purpose)
    .update("\0")
    .update(value)
    .digest("hex");
}

export function assertDataHashKeyConfigured() {
  const secret = process.env.XNEARBY_DATA_HASH_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("XNEARBY_DATA_HASH_KEY must contain at least 32 characters");
  }
}

export function normalizeVoucher(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }

  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "gift.truemoney.com" ||
      url.pathname !== "/campaign/"
    ) {
      return null;
    }

    return url.searchParams.get("v") || null;
  } catch {
    return null;
  }
}

export function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-3)}`;
}

export function maskAccountNumber(accountNo: string): string {
  const suffix = accountNo.match(/(\d{3,4})\D*$/)?.[1];
  return suffix ? `****${suffix}` : "****";
}
