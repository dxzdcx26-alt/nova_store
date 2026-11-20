import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { fetchHistory } from "@/lib/gafiw/client";
import {
  callGafiwLogged,
  gafiwErrorResponse,
  getGafiwApiKey,
  guardAdminMutation,
} from "@/lib/gafiw/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limited = await guardAdminMutation(request, "admin-gafiw-test");
  if (limited) return limited;

  try {
    const apiKey = await getGafiwApiKey({ requireEnabled: false });
    const result = await callGafiwLogged("/api_history", () =>
      fetchHistory({ apiKey, limit: 1 }),
    );
    await getPool().query(
      `UPDATE gafiw_settings
       SET connection_status = 'CONNECTED', last_tested_at = NOW(),
           last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
       WHERE id = 1`,
    );
    return NextResponse.json({ connected: true, historyRecords: result.length });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : "GAFIW connection test failed";
    await getPool().query(
      `UPDATE gafiw_settings
       SET connection_status = 'ERROR', last_tested_at = NOW(),
           last_error_code = $1, last_error_message = $2, updated_at = NOW()
       WHERE id = 1`,
      [code.slice(0, 80), message.slice(0, 500)],
    );
    return gafiwErrorResponse(error);
  }
}
