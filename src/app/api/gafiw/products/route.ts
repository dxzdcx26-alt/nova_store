import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const result = await getPool().query(
      `SELECT type_id, name, image_url, price, price_vip, stock, category, details, synced_at
       FROM gafiw_products ORDER BY name`,
    );
    return NextResponse.json({ products: result.rows });
  } catch {
    return NextResponse.json({ error: "Product catalog is unavailable" }, { status: 503 });
  }
}
