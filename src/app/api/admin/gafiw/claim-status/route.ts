import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { checkClaimStatus, GafiwApiError } from "@/lib/gafiw/client";
import {
  gafiwErrorResponse,
  getGafiwApiKey,
  guardAdminMutation,
  logGafiwRequest,
} from "@/lib/gafiw/server";
import { isJsonRecord } from "@/lib/xnearby/admin-utils";

export const runtime = "nodejs";

function safeField(value: unknown, maxLength = 500): string | number | null {
  if (typeof value === "string") return value.slice(0, maxLength);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export async function POST(request: Request) {
  const limited = await guardAdminMutation(request, "admin-gafiw-claim-status");
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (
    !isJsonRecord(body) ||
    (body.orderId !== undefined &&
      (typeof body.orderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(body.orderId)))
  ) {
    return NextResponse.json({ error: "Invalid order ID" }, { status: 400 });
  }

  const startedAt = Date.now();
  let responseCode: string | null = null;
  let httpStatus: number | null = null;
  try {
    const apiKey = await getGafiwApiKey();
    const rows = await checkClaimStatus({
      apiKey,
      orderId: typeof body.orderId === "string" ? body.orderId : undefined,
    });
    httpStatus = 200;
    const statuses = rows.filter(isJsonRecord).map((row) => ({
      order_id: safeField(row.order_id, 100),
      product_name: safeField(row.product_name, 200),
      type: safeField(row.type, 100),
      price: safeField(row.price),
      order_date: safeField(row.order_date, 100),
      status_text: safeField(row.status_text, 200),
      claim_status: safeField(row.claim_status, 100),
      claim_text: safeField(row.claim_text, 500),
      claim_time: safeField(row.claim_time, 100),
    }));

    for (const status of statuses) {
      if (typeof status.order_id !== "string") continue;
      await getPool().query(
        `UPDATE gafiw_claims
         SET claim_status = $2, claim_text = $3,
             claim_time = COALESCE($4, claim_time), updated_at = NOW()
         WHERE order_id = $1`,
        [
          status.order_id,
          status.claim_status === null ? null : String(status.claim_status),
          status.claim_text === null ? null : String(status.claim_text),
          status.claim_time === null ? null : String(status.claim_time),
        ],
      );
    }
    await logGafiwRequest({
      endpoint: "/v1/check_claim_status.php",
      httpStatus,
      responseCode,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ statuses });
  } catch (error) {
    const known = error instanceof GafiwApiError;
    responseCode = known ? error.code : "INTERNAL_ERROR";
    httpStatus = known ? error.httpStatus : null;
    await logGafiwRequest({
      endpoint: "/v1/check_claim_status.php",
      httpStatus,
      responseCode,
      durationMs: Date.now() - startedAt,
    });
    return gafiwErrorResponse(error);
  }
}
