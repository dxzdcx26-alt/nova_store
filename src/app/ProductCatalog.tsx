"use client";

import Image from "next/image";
import { useMemo, useState } from "react";

export type CatalogProduct = {
  type_id: string;
  name: string;
  image_url: string | null;
  price: number;
  price_vip: number;
  stock: number;
  category: string;
  details: string;
};

export default function ProductCatalog({ products }: { products: CatalogProduct[] }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("name");

  const categories = useMemo(
    () => [...new Set(products.map((product) => product.category))].sort(),
    [products],
  );
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return products
      .filter((product) => category === "all" || product.category === category)
      .filter(
        (product) =>
          !query ||
          product.name.toLocaleLowerCase().includes(query) ||
          product.details.toLocaleLowerCase().includes(query),
      )
      .sort((a, b) =>
        sort === "price-asc"
          ? a.price - b.price
          : sort === "price-desc"
            ? b.price - a.price
            : a.name.localeCompare(b.name),
      );
  }, [products, search, category, sort]);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search products"
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          aria-label="Search products"
        />
        <select value={category} onChange={(event) => setCategory(event.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm" aria-label="Filter by category">
          <option value="all">All categories</option>
          {categories.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm" aria-label="Sort products">
          <option value="name">Name</option>
          <option value="price-asc">Price: low to high</option>
          <option value="price-desc">Price: high to low</option>
        </select>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-zinc-400">No products match these filters.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((product) => (
            <article key={product.type_id} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
              <div className="relative aspect-[16/10] bg-zinc-800">
                {product.image_url ? (
                  <Image src={product.image_url} alt={product.name} fill sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" className="object-cover" />
                ) : <div className="flex h-full items-center justify-center text-sm text-zinc-500">No image</div>}
              </div>
              <div className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold">{product.name}</h2>
                  <span className="shrink-0 rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-300">{product.category}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span>฿{product.price.toLocaleString("th-TH")}</span>
                  <span className="text-cyan-300">VIP ฿{product.price_vip.toLocaleString("th-TH")}</span>
                </div>
                <p className="text-xs text-zinc-400">Stock: {product.stock}</p>
                {product.details && <p className="line-clamp-4 whitespace-pre-line text-sm text-zinc-400">{product.details}</p>}
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="text-center text-xs text-zinc-500">
        Catalog only. Checkout is unavailable until real customer accounts and payment verification are integrated.
      </p>
    </div>
  );
}
