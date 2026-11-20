import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { GafiwApiError, submitClaim } from "@/lib/gafiw/client";
import {
  gafiwErrorResponse,
  getGafiwApiKey,
  guardAdminMutation,
  logGafiwRequest,
} from "@/lib/gafiw/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limited = await guardAdminMutation(request, "admin-gafiw-claim");
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid claim request" }, { status: 400 });
  }
  const { orderId, reason } = body as Record<string, unknown>;
  if (
    typeof orderId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(orderId) ||
    typeof reason !== "string" ||
    reason.trim().length < 1 ||
    reason.length > 2000
  ) {
    return NextResponse.json({ error: "Invalid order ID or claim reason" }, { status: 400 });
  }

  const reservation = await getPool().query(
    `INSERT INTO gafiw_claims (order_id, reason, submission_status)
     VALUES ($1, $2, 'SUBMITTING')
     ON CONFLICT (order_id) DO NOTHING
     RETURNING order_id`,
    [orderId, reason.trim()],
  );
  if (reservation.rowCount !== 1) {
    return NextResponse.json(
      { error: "A claim attempt already exists for this order; check its status before proceeding" },
      { status: 409 },
    );
  }

  const startedAt = Date.now();
  let responseCode: string | null = null;
  let httpStatus: number | null = null;
  try {
    const apiKey = await getGafiwApiKey();
    const result = await submitClaim({ apiKey, orderId, reason: reason.trim() });
    httpStatus = 200;
    const data =
      result.data !== null && typeof result.data === "object" && !Array.isArray(result.data)
        ? (result.data as Record<string, unknown>)
        : {};
    const claimTime =
      typeof data.claim_time === "string" ? data.claim_time.slice(0, 100) : null;
    await getPool().query(
      `UPDATE gafiw_claims
       SET submission_status = 'SUBMITTED', claim_time = $2,
           updated_at = NOW()
       WHERE order_id = $1`,
      [orderId, claimTime],
    );
    try {
      await logGafiwRequest({
        endpoint: "/api_claim",
        httpStatus,
        responseCode,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      return NextResponse.json({
        submitted: true,
        message: "GAFIW accepted the claim request. API logging failed; do not submit it again.",
        loggingError: true,
      });
    }
    return NextResponse.json({
      submitted: true,
      claimTime,
      message: "Claim request submitted; this does not mean a refund or claim was approved.",
    });
  } catch (error) {
    const known = error instanceof GafiwApiError;
    responseCode = known ? error.code : "INTERNAL_ERROR";
    httpStatus = known ? error.httpStatus : null;
    const outcomeUnknown = !known || error.outcomeUnknown;
    await getPool().query(
      `UPDATE gafiw_claims
       SET submission_status = $2, response_code = $3, updated_at = NOW()
       WHERE order_id = $1`,
      [orderId, outcomeUnknown ? "UNKNOWN" : "REJECTED", responseCode],
    );
    await logGafiwRequest({
      endpoint: "/api_claim",
      httpStatus,
      responseCode,
      durationMs: Date.now() - startedAt,
    });
    return gafiwErrorResponse(error);
  }
}
