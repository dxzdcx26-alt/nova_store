import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";
import { decryptApiKey } from "@/lib/gafiw/crypto";
import { GafiwApiError } from "@/lib/gafiw/client";
import { isJsonRecord, requireAdmin, rateLimitResponse } from "@/lib/xnearby/admin-utils";

type EncryptedKeyRow = {
  api_key_ciphertext: string | null;
  api_key_iv: string | null;
  api_key_tag: string | null;
  enabled: boolean;
};

export async function getGafiwApiKey(options: { requireEnabled?: boolean } = {}) {
  const result = await getPool().query<EncryptedKeyRow>(
    `SELECT api_key_ciphertext, api_key_iv, api_key_tag, enabled
     FROM gafiw_settings WHERE id = 1`,
  );
  const settings = result.rows[0];
  if (!settings) {
    throw new GafiwApiError("GAFIW settings migration is missing", "SETTINGS_MISSING", null);
  }
  if (options.requireEnabled !== false && !settings.enabled) {
    throw new GafiwApiError("GAFIW API is disabled", "API_DISABLED", null);
  }
  if (!settings.api_key_ciphertext || !settings.api_key_iv || !settings.api_key_tag) {
    throw new GafiwApiError("GAFIW API key is not configured", "API_KEY_MISSING", null);
  }

  export async function assertGafiwEnabled() {
    const result = await getPool().query<{ enabled: boolean }>(
      `SELECT enabled FROM gafiw_settings WHERE id = 1`,
    );
    if (!result.rows[0]) {
      throw new GafiwApiError("GAFIW settings migration is missing", "SETTINGS_MISSING", null);
    }
    if (!result.rows[0].enabled) {
      throw new GafiwApiError("GAFIW API is disabled", "API_DISABLED", null);
    }
  }

  try {
    return decryptApiKey({
      ciphertext: settings.api_key_ciphertext,
      iv: settings.api_key_iv,
      tag: settings.api_key_tag,
    });
  } catch {
    throw new GafiwApiError(
      "Could not decrypt the stored GAFIW API key; verify GAFIW_ENCRYPTION_KEY",
      "SECRET_DECRYPTION_FAILED",
      null,
    );
  }
}

export function guardAdminMutation(request: Request, bucket: string) {
  const denied = requireAdmin(request);
  if (denied) return Promise.resolve(denied);
  if (!assertSameOrigin(request)) {
    return Promise.resolve(
      NextResponse.json({ error: "Invalid request origin" }, { status: 403 }),
    );
  }
  return rateLimitResponse(bucket, 20, 60);
}

export async function logGafiwRequest(input: {
  endpoint: string;
  httpStatus: number | null;
  responseCode: string | null;
  durationMs: number;
}) {
  const durationMs = Math.max(0, Math.min(2_147_483_647, Math.floor(input.durationMs)));
  await getPool().query(
    `INSERT INTO gafiw_api_logs (endpoint, http_status, response_code, duration_ms)
     VALUES ($1, $2, $3, $4)`,
    [input.endpoint, input.httpStatus, input.responseCode, durationMs],
  );
  await getPool().query(
    `INSERT INTO api_request_logs
       (provider, endpoint, http_status, response_code, duration_ms)
     VALUES ('gafiw', $1, $2, $3, $4)`,
    [input.endpoint, input.httpStatus, input.responseCode, durationMs],
  );
  if (input.responseCode) {
    await getPool().query(
      `INSERT INTO api_error_logs (provider, endpoint, http_status, error_code)
       VALUES ('gafiw', $1, $2, $3)`,
      [input.endpoint, input.httpStatus, input.responseCode],
    );
  }
}

export async function callGafiwLogged<T>(
  endpoint: string,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let httpStatus: number | null = null;
  let responseCode: string | null = null;
  try {
    const result = await action();
    httpStatus = 200;
    return result;
  } catch (error) {
    if (error instanceof GafiwApiError) {
      httpStatus = error.httpStatus;
      responseCode = error.code;
    } else {
      responseCode = "INTERNAL_ERROR";
    }
    throw error;
  } finally {
    await logGafiwRequest({
      endpoint,
      httpStatus,
      responseCode,
      durationMs: Date.now() - startedAt,
    });
  }
}

export function gafiwErrorResponse(error: unknown) {
  const known = error instanceof GafiwApiError;
  const message = known ? error.message : "GAFIW request could not be completed";
  const code = known ? error.code : "INTERNAL_ERROR";
  const status =
    code === "API_DISABLED" || code === "API_KEY_MISSING" ? 409 :
    code === "SETTINGS_MISSING" || code === "SECRET_DECRYPTION_FAILED" ? 503 :
    code === "TIMEOUT" ? 504 :
    known && error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500
      ? error.httpStatus
      : 502;
  return NextResponse.json({ error: message, code }, { status });
}

export function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  return isJsonRecord(value) ? value : null;
}
