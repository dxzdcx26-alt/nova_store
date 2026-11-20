import { NextResponse } from "next/server";
import { getPool, withTransaction } from "@/lib/db";
import { encryptApiKey } from "@/lib/gafiw/crypto";
import { guardAdminMutation } from "@/lib/gafiw/server";
import { requireAdmin } from "@/lib/xnearby/admin-utils";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const result = await getPool().query(
      `SELECT enabled, connection_status, last_tested_at,
              last_error_code, last_error_message, updated_at,
              (api_key_ciphertext IS NOT NULL) AS api_key_configured
       FROM gafiw_settings WHERE id = 1`,
    );
    if (!result.rows[0]) {
      return NextResponse.json({ error: "GAFIW migration is missing" }, { status: 503 });
    }
    return NextResponse.json(result.rows[0]);
  } catch {
    return NextResponse.json({ error: "Could not load GAFIW settings" }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const limited = await guardAdminMutation(request, "admin-gafiw-settings");
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).enabled !== "boolean"
  ) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }
  const fields = body as Record<string, unknown>;
  const apiKey = fields.apiKey;
  const clearApiKey = fields.clearApiKey === true;
  if (
    (apiKey !== undefined &&
      (typeof apiKey !== "string" ||
        apiKey.trim().length < 1 ||
        apiKey.length > 500 ||
        /[\r\n]/.test(apiKey))) ||
    (clearApiKey && apiKey !== undefined)
  ) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 400 });
  }

  try {
    const encrypted =
      typeof apiKey === "string" ? encryptApiKey(apiKey.trim()) : null;
    await withTransaction(async (client) => {
      const current = await client.query<{ api_key_ciphertext: string | null }>(
        `SELECT api_key_ciphertext FROM gafiw_settings WHERE id = 1 FOR UPDATE`,
      );
      if (!current.rows[0]) throw new Error("GAFIW settings row is missing");
      const hasKey = clearApiKey
        ? false
        : Boolean(encrypted || current.rows[0].api_key_ciphertext);
      if (fields.enabled && !hasKey) {
        throw new Error("An API key is required before enabling GAFIW");
      }

      await client.query(
        `UPDATE gafiw_settings
         SET api_key_ciphertext = CASE
               WHEN $1::boolean THEN NULL
               WHEN $2::boolean THEN $3
               ELSE api_key_ciphertext
             END,
             api_key_iv = CASE
               WHEN $1::boolean THEN NULL
               WHEN $2::boolean THEN $4
               ELSE api_key_iv
             END,
             api_key_tag = CASE
               WHEN $1::boolean THEN NULL
               WHEN $2::boolean THEN $5
               ELSE api_key_tag
             END,
             enabled = $6,
             connection_status = 'DISCONNECTED',
             last_tested_at = NULL,
             last_error_code = NULL,
             last_error_message = NULL,
             updated_at = NOW()
         WHERE id = 1`,
        [
          clearApiKey,
          Boolean(encrypted),
          encrypted?.ciphertext ?? null,
          encrypted?.iv ?? null,
          encrypted?.tag ?? null,
          fields.enabled,
        ],
      );
      await client.query(
        `UPDATE api_providers SET enabled = $1, updated_at = NOW() WHERE id = 'gafiw'`,
        [fields.enabled],
      );
      await client.query(
        `INSERT INTO audit_logs (actor, action, entity_type, entity_id, details)
         VALUES ('admin', 'settings.updated', 'gafiw_settings', '1', $1::jsonb)`,
        [
          JSON.stringify({
            enabled: fields.enabled,
            apiKeyChanged: Boolean(encrypted),
            apiKeyCleared: clearApiKey,
          }),
        ],
      );
    });
    return NextResponse.json({ saved: true });
  } catch (error) {
    const message =
      error instanceof Error && error.message === "An API key is required before enabling GAFIW"
        ? error.message
        : "Could not save GAFIW settings";
    return NextResponse.json({ error: message }, { status: message.startsWith("An API") ? 400 : 503 });
  }
}
