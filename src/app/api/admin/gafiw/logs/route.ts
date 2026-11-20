import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/xnearby/admin-utils";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const result = await getPool().query(
      `SELECT endpoint, http_status, response_code, duration_ms, created_at
       FROM gafiw_api_logs ORDER BY created_at DESC LIMIT 100`,
    );
    return NextResponse.json({ logs: result.rows });
  } catch {
    return NextResponse.json({ error: "Could not load GAFIW logs" }, { status: 503 });
  }
}
