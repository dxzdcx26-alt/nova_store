import { randomUUID } from "node:crypto";
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
  verifyVoucher,
} from "@/lib/xnearby/client";
import {
  assertDataHashKeyConfigured,
  hashVoucher,
  hashPhone,
  maskPhone,
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

  const limited = await rateLimitResponse("tmn-verify", 10, 60);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    !isJsonRecord(body) ||
    typeof body.voucher !== "string" ||
    typeof body.phone !== "string"
  ) {
    return NextResponse.json({ error: "Voucher and phone are required" }, { status: 400 });
  }

  const voucherHashValue = normalizeVoucher(body.voucher);
  const phone = body.phone.trim();
  if (!voucherHashValue || !/^0\d{9}$/.test(phone)) {
    return NextResponse.json(
      { error: "Provide a valid TrueMoney voucher and 10-digit phone number" },
      { status: 400 },
    );
  }

  try {
    const settings = await getPool().query<{ tmn_verify_enabled: boolean }>(
      "SELECT tmn_verify_enabled FROM api_settings WHERE id = 1",
    );
    if (!settings.rows[0]?.tmn_verify_enabled) {
      return NextResponse.json({ error: "TrueMoney verification is disabled" }, { status: 409 });
    }
  } catch {
    return NextResponse.json(
      { error: "Database unavailable or xNearby migration has not been applied" },
      { status: 503 },
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
  let id: string = randomUUID();
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO truemoney_transactions
           (id, voucher_hash, phone_hash, phone_masked, verification_status)
         VALUES ($1, $2, $3, $4, 'VERIFYING')`,
        [id, voucherHash, phoneHash, maskPhone(phone)],
      );
      await client.query(
        `INSERT INTO audit_logs (actor, action, entity_type, entity_id)
         VALUES ('admin', 'tmn.verification.started', 'truemoney_transaction', $1)`,
        [id],
      );
    });
  } catch (error) {
    if (isJsonRecord(error) && error.code === "23505") {
      try {
        const existing = await getPool().query<{
          id: string;
          owner_name: string | null;
          amount: string | null;
          available_tickets: number | null;
          provider_status: string | null;
          is_expired: boolean | null;
          verification_status: string;
          redemption_status: string;
        }>(
          `SELECT id, owner_name, amount::text, available_tickets,
                  provider_status, is_expired, verification_status,
                  redemption_status
           FROM truemoney_transactions
           WHERE voucher_hash = $1 AND phone_hash = $2`,
          [voucherHash, phoneHash],
        );
        const row = existing.rows[0];
        if (
          row?.verification_status === "VERIFIED" &&
          row.amount &&
          row.available_tickets !== null &&
          row.provider_status &&
          row.is_expired !== null
        ) {
          return NextResponse.json({
            transactionId: row.id,
            voucherHash: `${voucherHash.slice(0, 12)}…`,
            phone: maskPhone(phone),
            ownerName: row.owner_name,
            amount: row.amount,
            availableTickets: row.available_tickets,
            providerStatus: row.provider_status,
            isExpired: row.is_expired,
            verificationStatus: row.verification_status,
            redemptionStatus: row.redemption_status,
            responseCode: null,
          });
        }

        if (row?.verification_status === "FAILED") {
          const retried = await withTransaction(async (client) => {
            const result = await client.query(
              `UPDATE truemoney_transactions
               SET verification_status = 'VERIFYING',
                   response_code = NULL, updated_at = NOW()
               WHERE id = $1 AND verification_status = 'FAILED'
               RETURNING id`,
              [row.id],
            );
            if (result.rowCount === 1) {
              await client.query(
                `INSERT INTO audit_logs (actor, action, entity_type, entity_id)
                 VALUES ('admin', 'tmn.verification.retried', 'truemoney_transaction', $1)`,
                [row.id],
              );
            }
            return result;
          });
          if (retried.rowCount === 1) {
            id = row.id;
          } else {
            return NextResponse.json(
              { error: "Voucher verification is already in progress" },
              { status: 409 },
            );
          }
        } else {
          return NextResponse.json(
            {
              error: "This voucher already has a record for another phone or an unresolved attempt",
              retryAllowed: false,
            },
            { status: 409 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: "Could not load the existing TrueMoney record" },
          { status: 503 },
        );
      }
    } else {
      return NextResponse.json(
        { error: "Could not create the TrueMoney verification record" },
        { status: 503 },
      );
    }
  }

  const startedAt = Date.now();
  try {
    const response = await verifyVoucher(body.voucher.trim(), phone);
    const data = isJsonRecord(response.data) ? response.data : null;
    const amount = parseMoney(data?.total_amount ?? data?.amount);
    const availableTickets = data?.available_tickets;
    const providerStatus = data?.status;
    const isExpired = data?.is_expired;

    if (
      !data ||
      !amount ||
      typeof availableTickets !== "number" ||
      !Number.isInteger(availableTickets) ||
      availableTickets < 0 ||
      typeof providerStatus !== "string" ||
      typeof isExpired !== "boolean"
    ) {
      await updateVerification(id, "UNKNOWN", "INVALID_RESPONSE");
      await logApiRequest({
        endpoint: "/tmn/verify",
        httpStatus: 200,
        responseCode: "INVALID_RESPONSE",
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: "xNearby returned incomplete voucher details", transactionId: id },
        { status: 502 },
      );
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE truemoney_transactions
         SET owner_name = $2, amount = $3, available_tickets = $4,
             provider_status = $5, is_expired = $6,
             verification_status = 'VERIFIED', response_code = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [
          id,
          typeof data.owner_name === "string" ? data.owner_name : null,
          amount.decimal,
          availableTickets,
          providerStatus,
          isExpired,
        ],
      );
      await client.query(
        `INSERT INTO audit_logs (actor, action, entity_type, entity_id, details)
         VALUES ('admin', 'tmn.verification.completed', 'truemoney_transaction', $1, $2::jsonb)`,
        [
          id,
          JSON.stringify({
            status: "VERIFIED",
            providerStatus,
            isExpired,
          }),
        ],
      );
    });
    await logApiRequest({
      endpoint: "/tmn/verify",
      httpStatus: 200,
      responseCode: null,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      transactionId: id,
      voucherHash: `${voucherHash.slice(0, 12)}…`,
      phone: maskPhone(phone),
      ownerName: typeof data.owner_name === "string" ? data.owner_name : null,
      amount: amount.decimal,
      availableTickets,
      providerStatus,
      isExpired,
      verificationStatus: "VERIFIED",
      redemptionStatus: "NOT_REQUESTED",
      responseCode: null,
    });
  } catch (error) {
    const apiError =
      error instanceof NearbyApiError
        ? error
        : new NearbyApiError("Could not save xNearby result", "STORAGE_ERROR", null, true);
    const status = apiError.outcomeUnknown ? "UNKNOWN" : "FAILED";
    await updateVerification(id, status, apiError.code);
    await logApiRequest({
      endpoint: "/tmn/verify",
      httpStatus: apiError.httpStatus,
      responseCode: apiError.code,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        error: "Voucher verification did not complete",
        transactionId: id,
        responseCode: apiError.code,
      },
      { status: apiError.httpStatus === 400 ? 422 : 502 },
    );
  }
}

async function updateVerification(
  id: string,
  status: "FAILED" | "UNKNOWN",
  responseCode: string,
) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE truemoney_transactions
       SET verification_status = $2, response_code = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, status, responseCode],
    );
    await client.query(
      `INSERT INTO audit_logs (actor, action, entity_type, entity_id, details)
       VALUES ('admin', 'tmn.verification.failed', 'truemoney_transaction', $1, $2::jsonb)`,
      [id, JSON.stringify({ status, responseCode })],
    );
  });
}
