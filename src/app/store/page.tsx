import Link from "next/link";
import ProductCatalog, { type CatalogProduct } from "@/app/ProductCatalog";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

async function loadProducts(): Promise<CatalogProduct[]> {
  const result = await getPool().query(
    `SELECT type_id, name, image_url, price, price_vip, stock, category, details
     FROM gafiw_products ORDER BY name`,
  );
  return result.rows.map((row) => ({
    type_id: String(row.type_id),
    name: String(row.name),
    image_url: typeof row.image_url === "string" ? row.image_url : null,
    price: Number(row.price),
    price_vip: Number(row.price_vip),
    stock: Number(row.stock),
    category: String(row.category),
    details: String(row.details ?? ""),
  }));
}

export default async function StorePage() {
  let products: CatalogProduct[] = [];
  let catalogError = "";
  try {
    products = await loadProducts();
  } catch {
    catalogError = "Catalog is unavailable. Check the database migration and connection.";
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-800 pb-6">
          <div>
            <p className="text-sm font-medium tracking-wide text-cyan-400">NOVA STORE</p>
            <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">Product Catalog</h1>
            <p className="mt-2 text-sm text-zinc-400">Catalog data is synchronized from GAFIW Shop.</p>
          </div>
          <Link href="/admin/gafiw" className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-900">
            Admin dashboard
          </Link>
        </header>

        {catalogError ? (
          <p role="alert" className="rounded-xl border border-red-900 bg-red-950/40 p-5 text-red-300">{catalogError}</p>
        ) : products.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-zinc-300">
            <p>No products have been synchronized yet.</p>
            <p className="mt-2 text-sm text-zinc-500">An administrator can sync the live Product API from the GAFIW dashboard.</p>
          </div>
        ) : (
          <ProductCatalog products={products} />
        )}
      </div>
    </main>
  );
}
