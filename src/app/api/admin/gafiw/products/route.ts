import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";
import { fetchProducts } from "@/lib/gafiw/client";
import {
  callGafiwLogged,
  gafiwErrorResponse,
  guardAdminMutation,
} from "@/lib/gafiw/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limited = await guardAdminMutation(request, "admin-gafiw-products-sync");
  if (limited) return limited;

  try {
    const products = await callGafiwLogged("/api_product", fetchProducts);
    await withTransaction(async (client) => {
      for (const product of products) {
        const details = product.details
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/(p|div|li)>/gi, "\n")
          .replace(/<[^>]*>/g, "")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .slice(0, 20_000);
        await client.query(
          `INSERT INTO gafiw_products
             (type_id, name, image_url, price, price_vip, stock, category, details, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (type_id) DO UPDATE SET
             name = EXCLUDED.name,
             image_url = EXCLUDED.image_url,
             price = EXCLUDED.price,
             price_vip = EXCLUDED.price_vip,
             stock = EXCLUDED.stock,
             category = EXCLUDED.category,
             details = EXCLUDED.details,
             synced_at = NOW()`,
          [
            product.type_id,
            product.name,
            product.imageapi,
            product.price,
            product.pricevip,
            product.stock,
            product.type_menu,
            details,
          ],
        );
      }
    });
    return NextResponse.json({ synced: products.length });
  } catch (error) {
    return gafiwErrorResponse(error);
  }
}
