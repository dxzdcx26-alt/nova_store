import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/xnearby/admin-utils";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const result = await getPool().query(
      `SELECT order_id, reason, submission_status, claim_time, claim_status,
              claim_text, response_code, created_at, updated_at
       FROM gafiw_claims ORDER BY updated_at DESC LIMIT 100`,
    );
    return NextResponse.json({ claims: result.rows });
  } catch {
    return NextResponse.json({ error: "Could not load claim records" }, { status: 503 });
  }
}
