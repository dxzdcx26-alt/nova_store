import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/xnearby/admin-utils";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const pool = getPool();
    const [health, payments, vouchers, logs, auditLogs] = await Promise.all([
      pool.query("SELECT 1"),
      pool.query(
        `SELECT id, order_reference, amount::text, currency, status,
                provider_transaction_id,
                response_code, created_at
         FROM payment_transactions ORDER BY created_at DESC LIMIT 20`,
      ),
      pool.query(
        `SELECT id, voucher_hash, phone_masked, owner_name, amount::text,
                available_tickets, provider_status, is_expired,
                verification_status, redemption_status, response_code,
                redeemed_amount::text, redeemed_at, created_at
         FROM truemoney_transactions ORDER BY created_at DESC LIMIT 20`,
      ),
      pool.query(
        `SELECT endpoint, http_status, response_code, duration_ms, created_at
         FROM api_request_logs ORDER BY created_at DESC LIMIT 30`,
      ),
      pool.query(
        `SELECT actor, action, entity_type, entity_id, details, created_at
         FROM audit_logs ORDER BY created_at DESC LIMIT 30`,
      ),
    ]);

    return NextResponse.json({
      databaseConnected: health.rowCount === 1,
      apiKeyConfigured: Boolean(process.env.XNEARBY_API_KEY),
      liveRedeemEnabled: process.env.XNEARBY_LIVE_REDEEM_ENABLED === "true",
      payments: payments.rows,
      vouchers: vouchers.rows.map((row) => ({
        ...row,
        voucher_hash: `${String(row.voucher_hash).slice(0, 12)}…`,
      })),
      logs: logs.rows,
      auditLogs: auditLogs.rows,
    });
  } catch {
    return NextResponse.json(
      { error: "Could not load xNearby overview. Check database migration and connection." },
      { status: 503 },
    );
  }
}
