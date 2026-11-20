This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## xNearby Integration

This project includes an admin-only integration for the documented xNearby Slip Verification and TrueMoney APIs.

### Requirements and configuration

- Node.js 20.11 or later, PostgreSQL 14 or later, and an xNearby API key with the documented `v2` and/or `tmn` permission.
- Copy `.env.example` to `.env.local` for local development. Set `DATABASE_URL`, `XNEARBY_API_KEY`, `XNEARBY_ADMIN_PASSWORD` (at least 16 characters), `XNEARBY_SESSION_SECRET` (at least 32 characters), `XNEARBY_DATA_HASH_KEY` (at least 32 characters), and `XNEARBY_TIMEOUT_MS` (1,000–60,000 ms).
- `XNEARBY_DATA_HASH_KEY` is a stable random secret used to detect repeated vouchers and phones without storing their raw values. Do not rotate it unless existing database hashes are migrated.
- Leave `XNEARBY_LIVE_REDEEM_ENABLED=false` unless live redemption is intentionally enabled. Never commit `.env.local` or production credentials.
- Configure PostgreSQL TLS through the connection string or hosting provider in production.

Apply the schema migration once:

```bash
npm run db:migrate
```

Run `npm run dev`, open `/admin/xnearby`, sign in, and configure the expected receiver name, bank code, and account number before enabling slip verification.

### Safety and integration limits

- The backend calls only the documented endpoints: `POST /slipVerify/v2`, `POST /tmn/verify`, and `POST /tmn/redeem` at `https://api.nearbyshop.xyz`.
- The API key is read from the server environment. Request bodies, uploaded slips, voucher URLs, and API responses are not written to API logs. Slip images are not persisted; only a SHA-256 digest is stored for duplicate detection.
- Slip requests are not retried. Provider transaction IDs and uploaded-file digests have unique constraints. A payment is marked `PAID` only when xNearby returns a valid transaction ID and the amount matches the server-entered expected amount.
- A timeout or unclear live-redemption response is stored as `UNKNOWN`; that voucher cannot be redeemed again through this integration. Only documented definitive gateway rejections (invalid key, insufficient balance/permission, or missing endpoint) can be manually retried. The docs do not provide a redemption-status endpoint, so reconcile an unknown result with xNearby before taking further action.
- TrueMoney requests default to Dry Run in the UI. Live redemption requires `XNEARBY_LIVE_REDEEM_ENABLED=true`, an authenticated admin, and the explicit confirmation text `REDEEM`.
- xNearby's published docs do not describe an API balance endpoint or remote health-check endpoint. The dashboard reports local database and configuration readiness only; it does not claim that the remote API was contacted.
- This repository started as a blank Next.js template. It has no customer accounts, checkout, order fulfillment, or credit ledger. Slip verifications are recorded in the integration database only; a `PAID` record does not deliver a product or add customer credit. Connect the verified-payment service to a real order/fulfillment system before using it as a customer-facing production checkout.
- Live provider verification requires the store owner's API key and a permitted test setup. No credentials are included here, and live TrueMoney redemption must not be used as a test.

## GAFIW Shop Integration

- The GAFIW adapter uses the Product, Buy, History, Claim, and Check Claim Status endpoints at `https://gafiwshop.xyz/api`. The API key is encrypted with AES-256-GCM in PostgreSQL and is never returned to the browser.
- Configure `GAFIW_ENCRYPTION_KEY` before saving an API key. Generate a stable 32-byte key (for example, `openssl rand -base64 32`) and keep it in the server's secret manager. Do not rotate it without re-encrypting the stored key.
- Run `npm run db:migrate` to apply both migrations. Sign in at `/admin/gafiw`, save the GAFIW API key, enable the integration, then sync products. The read-only connection test calls History API and requires a valid key.
- The synchronized catalog is available at `/store`, with search, category filtering, and price sorting. The Product API was reachable without a key during implementation; product updates require an administrator to sync.
- Admin history, claim, status, and request-log routes are protected by the existing signed admin session, same-origin checks for mutations, and database-backed rate limits. API keys and provider response bodies are not written to logs. History detail may contain sensitive delivery data and is displayed only in the admin dashboard.
- Buy API integration exists only as a server-side adapter. It is not exposed as a purchase action: this repository has no customer login/ownership, wallet, payment gateway, or order/fulfillment system. Do not call Buy API or enable customer purchases until a real payment and order pipeline is integrated. Purchase calls are never automatically retried because the provider does not document idempotency support.
- No sample products are bundled. Buy, History, Claim, and Claim Status could not be live-validated without an owner-provided API key; no purchase or claim was made. Test these only with an owner-approved provider test setup.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
