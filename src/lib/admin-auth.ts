import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "xnearby_admin";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function getSessionSecret(): string {
  const secret = process.env.XNEARBY_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("XNEARBY_SESSION_SECRET must contain at least 32 characters");
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSessionSecret())
    .update(payload)
    .digest("base64url");
}

export function verifyAdminPassword(candidate: string): boolean {
  const configured = process.env.XNEARBY_ADMIN_PASSWORD;
  if (!configured || configured.length < 16) {
    throw new Error("XNEARBY_ADMIN_PASSWORD must contain at least 16 characters");
  }

  const candidateDigest = createHmac("sha256", "xnearby-admin-password")
    .update(candidate)
    .digest();
  const configuredDigest = createHmac("sha256", "xnearby-admin-password")
    .update(configured)
    .digest();
  return timingSafeEqual(candidateDigest, configuredDigest);
}

export function createAdminCookie(): string {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = String(expiresAt);
  const value = `${payload}.${sign(payload)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function clearAdminCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

export function isAdminRequest(request: Request): boolean {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));

  if (!cookie) return false;
  const value = cookie.slice(COOKIE_NAME.length + 1);
  const separator = value.lastIndexOf(".");
  if (separator < 1) return false;

  const payload = value.slice(0, separator);
  const providedSignature = value.slice(separator + 1);
  const expiresAt = Number(payload);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() / 1000) {
    return false;
  }

  try {
    const expectedSignature = sign(payload);
    const provided = Buffer.from(providedSignature);
    const expected = Buffer.from(expectedSignature);
    return (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    );
  } catch {
    return false;
  }
}

export function assertSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
