import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/admin-auth";
import { getPool, withTransaction } from "@/lib/db";
import {
  isJsonRecord,
  logApiRequest,
  rateLimitResponse,
  requireAdmin,
} from "@/lib/xnearby/admin-utils";
import {
  assertXNearbyConfigured,
  NearbyApiError,
  redeemVoucher,
} from "@/lib/xnearby/client";
import {
  assertDataHashKeyConfigured,
  hashVoucher,
  hashPhone,
  normalizeVoucher,
  parseMoney,
} from "@/lib/xnearby/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (!assertSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  const limited = await rateLimitResponse("tmn-redeem", 5, 60);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    !isJsonRecord(body) ||
    typeof body.transactionId !== "string" ||
    typeof body.voucher !== "string" ||
    typeof body.phone !== "string" ||
    typeof body.dryRun !== "boolean"
  ) {
    return NextResponse.json(
      { error: "Transaction, voucher, phone, and dryRun are required" },
      { status: 400 },
    );
  }

  const voucherHashValue = normalizeVoucher(body.voucher);
  const phone = body.phone.trim();
  if (!voucherHashValue || !/^0\d{9}$/.test(phone)) {
    return NextResponse.json(
      { error: "Provide a valid TrueMoney voucher and 10-digit phone number" },
      { status: 400 },
    );
  }

  const liveRedeem = body.dryRun === false;
  if (
    liveRedeem &&
    (process.env.XNEARBY_LIVE_REDEEM_ENABLED !== "true" ||
      body.confirmation !== "REDEEM")
  ) {
    return NextResponse.json(
      { error: "Live redemption is disabled or explicit REDEEM confirmation is missing" },
      { status: 403 },
    );
  }

  try {
    assertXNearbyConfigured();
    assertDataHashKeyConfigured();
  } catch (error) {
    return NextResponse.json(
      {
        error: "xNearby API or TrueMoney data-hash configuration is not ready",
        responseCode: error instanceof NearbyApiError ? error.code : "CONFIG_ERROR",
      },
      { status: 503 },
    );
  }

  const voucherHash = hashVoucher(voucherHashValue);
  const phoneHash = hashPhone(phone);
  let current;
  try {
    const result = await getPool().query<{
      verification_status: string;
      provider_status: string | null;
      is_expired: boolean | null;
      available_tickets: number | null;
      redemption_status: string;
      tmn_verify_enabled: boolean;
      phone_hash: string;
      response_code: string | null;
    }>(
      `SELECT t.verification_status, t.provider_status, t.is_expired,
              t.available_tickets, t.redemption_status, s.tmn_verify_enabled,
              t.phone_hash, t.response_code
       FROM truemoney_transactions t
       JOIN api_settings s ON s.id = 1
       WHERE t.id = $1 AND t.voucher_hash = $2`,
      [body.transactionId, voucherHash],
    );
    current = result.rows[0];
  } catch {
    return NextResponse.json(
      { error: "Could not load the TrueMoney transaction" },
      { status: 503 },
    );
  }

  if (
    !current ||
    !current.tmn_verify_enabled ||
    current.phone_hash !== phoneHash ||
    current.verification_status !== "VERIFIED" ||
    current.provider_status !== "ACTIVE" ||
    current.is_expired !== false ||
    current.available_tickets === null ||
    current.available_tickets < 1
  ) {
    return NextResponse.json(
      { error: "Voucher must be verified, active, unexpired, and have available tickets" },
      { status: 409 },
    );
  }

  const nextStatus = body.dryRun ? "DRY_RUN_PENDING" : "REDEEMING";
  const allowedStatuses = [
    "NOT_REQUESTED",
    "DRY_RUN_SUCCEEDED",
    "DRY_RUN_FAILED",
  ];
  const safeRetryCodes = [
    "INVALID_API_KEY",
    "INSUFFICIENT_BALANCE",
    "INSUFFICIENT_PERMISSIONS",
    "ENDPOINT_NOT_FOUND",
    "HTTP_401",
    "HTTP_402",
    "HTTP_403",
    "HTTP_404",
  ];

  let reserved;
  try {
    reserved = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE truemoney_transactions
         SET redemption_status = $3, phone_masked = $4,
             response_code = NULL, updated_at = NOW()
         WHERE id = $1 AND voucher_hash = $2
           AND verification_status = 'VERIFIED'
           AND provider_status = 'ACTIVE' AND is_expired = FALSE
           AND available_tickets > 0
           AND (
             redemption_status = ANY($5::text[])
             OR (redemption_status = 'FAILED' AND response_code = ANY($6::text[]))
           )
         RETURNING id`,
        [
          body.transactionId,
          voucherHash,
          nextStatus,
          `${phone.slice(0, 3)}****${phone.slice(-3)}`,
          allowedStatuses,
          safeRetryCodes,
        ],
      );
      if (result.rowCount === 1) {
        await client.query(
          `INSERT INTO audit_logs (actor, action, entity_type, entity_id, details)
           VALUES ('admin', 'tmn.redemption.started', 'truemoney_transaction', $1, $2::jsonb)`,
          [
            body.transactionId,
            JSON.stringify({
              dryRun: body.dryRun,
              retryAfterDefinitiveRejection:
                current.redemption_status === "FAILED" &&
                safeRetryCodes.includes(current.response_code ?? ""),
            }),
          ],
        );
      }
      return result;
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reserve the TrueMoney transaction" },
      { status: 503 },
    );
  }

  if (reserved.rowCount !== 1) {
    return NextResponse.json(
      {
        error: "This voucher already has a redemption attempt or is not eligible",
        retryAllowed: false,
      },
      { status: 409 },
    );
  }

  const startedAt = Date.now();
  try {
    const response = await redeemVoucher(body.voucher.trim(), phone, body.dryRun);
    const data = isJsonRecord(response.data) ? response.data : null;
    const receivedAmount = parseMoney(data?.received_amount);
    const responsePhone =
      typeof data?.phone === "string" ? data.phone.replace(/\D/g, "") : "";
    const redeemedAt =
      typeof data?.redeemed_at === "string" ? new Date(data.redeemed_at) : null;
    if (
      !body.dryRun &&
      (!receivedAmount ||
        responsePhone !== phone ||
        !redeemedAt ||
        !Number.isFinite(redeemedAt.getTime()))
    ) {
      await setRedemptionStatus(body.transactionId, "UNKNOWN", "INVALID_RESPONSE");
      await logApiRequest({
        endpoint: "/tmn/redeem",
        httpStatus: 200,
        responseCode: "INVALID_RESPONSE",
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        {
          error: "Redemption result is unclear; do not retry this voucher",
          transactionId: body.transactionId,
          status: "UNKNOWN",
        },
        { status: 502 },
      );
    }

    const redemptionStatus = body.dryRun ? "DRY_RUN_SUCCEEDED" : "REDEEMED";
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE truemoney_transactions
         SET redemption_status = $2, redeemed_amount = $3,
             redeemed_at = CASE WHEN $2 = 'REDEEMED' THEN $4 ELSE redeemed_at END,
             response_code = NULL, updated_at = NOW()
         WHERE id = $1`,
        [
          body.transactionId,
          redemptionStatus,
          receivedAmount?.decimal ?? null,
          redeemedAt?.toISOString() ?? null,
        ],
      );
      await client.query(
        `INSERT INTO audit_logs (actor, action, entity_type, entity_id, details)
         VALUES ('admin', 'tmn.redemption.completed', 'truemoney_transaction', $1, $2::jsonb)`,
        [
          body.transactionId,
          JSON.stringify({
            status: redemptionStatus,
            dryRun: body.dryRun,
          }),
        ],
      );
    });
    await logApiRequest({
      endpoint: "/tmn/redeem",
      httpStatus: 200,
      responseCode: null,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      transactionId: body.transactionId,
      dryRun: body.dryRun,
      redemptionStatus,
      receivedAmount: receivedAmount?.decimal ?? null,
      message: body.dryRun
        ? "Dry run completed; no real redemption was performed"
        : "Redemption completed",
    });
  } catch (error) {
    const apiError =
      error instanceof NearbyApiError
        ? error
        : new NearbyApiError("Could not save xNearby result", "STORAGE_ERROR", null, true);
    const status = body.dryRun
      ? "DRY_RUN_FAILED"
      : apiError.outcomeUnknown
        ? "UNKNOWN"
        : "FAILED";

    await setRedemptionStatus(body.transactionId, status, apiError.code);
    await logApiRequest({
      endpoint: "/tmn/redeem",
      httpStatus: apiError.httpStatus,
      responseCode: apiError.code,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        error: body.dryRun
          ? "Dry run failed"
          : status === "UNKNOWN"
            ? "Redemption result is unclear; do not retry this voucher"
            : "Redemption was rejected; this voucher cannot be retried automatically",
        transactionId: body.transactionId,
        status,
        responseCode: apiError.code,
        retryAllowed: false,
      },
      { status: apiError.httpStatus === 400 ? 422 : 502 },
    );
  }
}

async function setRedemptionStatus(
  id: string,
  status: "DRY_RUN_FAILED" | "FAILED" | "UNKNOWN",
  responseCode: string,
) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE truemoney_transactions
       SET redemption_status = $2, response_code = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, status, responseCode],
    );
    await client.query(
      `INSERT INTO audit_logs (actor, action, entity_type, entity_id, details)
       VALUES ('admin', 'tmn.redemption.failed', 'truemoney_transaction', $1, $2::jsonb)`,
      [id, JSON.stringify({ status, responseCode })],
    );
  });
}
