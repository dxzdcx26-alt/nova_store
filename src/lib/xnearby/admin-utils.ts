import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin-auth";
import { getPool } from "@/lib/db";

export function unauthorizedResponse() {
  return NextResponse.json({ error: "Admin authentication required" }, { status: 401 });
}

export function requireAdmin(request: Request): NextResponse | null {
  return isAdminRequest(request) ? null : unauthorizedResponse();
}

export async function consumeRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const result = await getPool().query<{ request_count: number }>(
    `INSERT INTO api_rate_limits (bucket, window_started_at, request_count)
     VALUES ($1, NOW(), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       request_count = CASE
         WHEN api_rate_limits.window_started_at <= NOW() - ($2::integer * INTERVAL '1 second')
           THEN 1
         ELSE api_rate_limits.request_count + 1
       END,
       window_started_at = CASE
         WHEN api_rate_limits.window_started_at <= NOW() - ($2::integer * INTERVAL '1 second')
           THEN NOW()
         ELSE api_rate_limits.window_started_at
       END,
       updated_at = NOW()
     RETURNING request_count`,
    [bucket, windowSeconds],
  );

  return result.rows[0].request_count <= limit;
}

export async function rateLimitResponse(
  bucket: string,
  limit: number,
  windowSeconds: number,
) {
  try {
    if (await consumeRateLimit(bucket, limit, windowSeconds)) return null;
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  } catch {
    return NextResponse.json(
      { error: "Rate limiter is unavailable; request was not processed" },
      { status: 503 },
    );
  }
}

export async function logApiRequest(input: {
  endpoint: string;
  httpStatus: number | null;
  responseCode: string | null;
  durationMs: number;
}) {
  await getPool().query(
    `INSERT INTO api_request_logs
       (provider, endpoint, http_status, response_code, duration_ms)
     VALUES ('xnearby', $1, $2, $3, $4)`,
    [
      input.endpoint,
      input.httpStatus,
      input.responseCode,
      Math.max(0, Math.min(2_147_483_647, Math.floor(input.durationMs))),
    ],
  );

  if (input.responseCode) {
    await getPool().query(
      `INSERT INTO api_error_logs (provider, endpoint, http_status, error_code)
       VALUES ('xnearby', $1, $2, $3)`,
      [input.endpoint, input.httpStatus, input.responseCode],
    );
  }
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
