import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/admin-auth";
import { getPool, withTransaction } from "@/lib/db";
import {
  isJsonRecord,
  rateLimitResponse,
  requireAdmin,
} from "@/lib/xnearby/admin-utils";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const result = await getPool().query(
      `SELECT slip_enabled, tmn_verify_enabled, expected_receiver_name,
              expected_bank_code, expected_account_no, updated_at
       FROM api_settings WHERE id = 1`,
    );
    const settings = result.rows[0];
    if (!settings) {
      return NextResponse.json({ error: "Settings migration is missing" }, { status: 503 });
    }

    return NextResponse.json({
      ...settings,
      apiKeyConfigured: Boolean(process.env.XNEARBY_API_KEY),
      liveRedeemEnabled: process.env.XNEARBY_LIVE_REDEEM_ENABLED === "true",
    });
  } catch {
    return NextResponse.json({ error: "Could not load xNearby settings" }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (!assertSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  const limited = await rateLimitResponse("admin-settings", 20, 60);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    !isJsonRecord(body) ||
    typeof body.slipEnabled !== "boolean" ||
    typeof body.tmnVerifyEnabled !== "boolean" ||
    typeof body.expectedReceiverName !== "string" ||
    typeof body.expectedBankCode !== "string" ||
    typeof body.expectedAccountNo !== "string"
  ) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }

  const receiverName = body.expectedReceiverName.trim();
  const bankCode = body.expectedBankCode.trim();
  const accountNo = body.expectedAccountNo.trim();
  if (
    receiverName.length > 120 ||
    bankCode.length > 16 ||
    accountNo.length > 32 ||
    (body.slipEnabled && (!receiverName || !bankCode || !accountNo))
  ) {
    return NextResponse.json(
      { error: "Valid receiver name, bank code, and account number are required" },
      { status: 400 },
    );
  }

  try {
    await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE api_settings
         SET slip_enabled = $1,
             tmn_verify_enabled = $2,
             expected_receiver_name = $3,
             expected_bank_code = $4,
             expected_account_no = $5,
             updated_at = NOW()
         WHERE id = 1`,
        [
          body.slipEnabled,
          body.tmnVerifyEnabled,
          receiverName,
          bankCode,
          accountNo,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error("xNearby settings row is missing");
      }
      await client.query(
        `INSERT INTO audit_logs (actor, action, entity_type, entity_id, details)
         VALUES ('admin', 'settings.updated', 'api_settings', '1', $1::jsonb)`,
        [
          JSON.stringify({
            slipEnabled: body.slipEnabled,
            tmnVerifyEnabled: body.tmnVerifyEnabled,
          }),
        ],
      );
    });
    return NextResponse.json({ saved: true });
  } catch {
    return NextResponse.json({ error: "Could not save xNearby settings" }, { status: 503 });
  }
}
