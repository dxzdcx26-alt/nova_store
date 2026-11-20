"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type Settings = {
  slip_enabled: boolean;
  tmn_verify_enabled: boolean;
  expected_receiver_name: string;
  expected_bank_code: string;
  expected_account_no: string;
  apiKeyConfigured: boolean;
  liveRedeemEnabled: boolean;
};

type Overview = {
  databaseConnected: boolean;
  apiKeyConfigured: boolean;
  liveRedeemEnabled: boolean;
  payments: Record<string, unknown>[];
  vouchers: Record<string, unknown>[];
  logs: Record<string, unknown>[];
  auditLogs: Record<string, unknown>[];
};

type TmnResult = {
  transactionId: string;
  voucherHash: string;
  phone: string;
  ownerName: string | null;
  amount: string;
  availableTickets: number;
  providerStatus: string;
  isExpired: boolean;
  verificationStatus: string;
  redemptionStatus: string;
  responseCode: string | null;
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String(body.error)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function display(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export default function XNearbyAdminPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tmnResult, setTmnResult] = useState<TmnResult | null>(null);
  const [voucher, setVoucher] = useState("");
  const [phone, setPhone] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [nextSettings, nextOverview] = await Promise.all([
      requestJson<Settings>("/api/admin/settings"),
      requestJson<Overview>("/api/admin/overview"),
    ]);
    setSettings(nextSettings);
    setOverview(nextOverview);
  }, []);

  useEffect(() => {
    void requestJson<{ authenticated: boolean }>("/api/admin/session")
      .then(async (session) => {
        setAuthenticated(session.authenticated);
        if (session.authenticated) await refresh();
      })
      .catch((cause: unknown) => {
        setAuthenticated(false);
        setError(cause instanceof Error ? cause.message : "Could not check session");
      });
  }, [refresh]);

  async function submit(
    event: FormEvent<HTMLFormElement>,
    action: () => Promise<void>,
  ) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await requestJson("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      setPassword("");
      setAuthenticated(true);
      await refresh();
    });
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    if (!settings) return;
    await submit(event, async () => {
      await requestJson("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slipEnabled: settings.slip_enabled,
          tmnVerifyEnabled: settings.tmn_verify_enabled,
          expectedReceiverName: settings.expected_receiver_name,
          expectedBankCode: settings.expected_bank_code,
          expectedAccountNo: settings.expected_account_no,
        }),
      });
      setNotice("Settings saved.");
      await refresh();
    });
  }

  async function verifySlip(event: FormEvent<HTMLFormElement>) {
    const formElement = event.currentTarget;
    await submit(event, async () => {
      const form = new FormData(formElement);
      await requestJson("/api/admin/slips", { method: "POST", body: form });
      setNotice("Slip verification completed. Review the saved payment status below.");
      formElement.reset();
      await refresh();
    });
  }

  async function verifyVoucher(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      const result = await requestJson<TmnResult>("/api/admin/tmn/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voucher, phone }),
      });
      setTmnResult(result);
      setNotice("Voucher verified. No funds have been received.");
      await refresh();
    });
  }

  async function redeem(event: FormEvent<HTMLFormElement>) {
    if (!tmnResult) return;
    await submit(event, async () => {
      try {
        const result = await requestJson<{
          redemptionStatus: string;
          message: string;
        }>("/api/admin/tmn/redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transactionId: tmnResult.transactionId,
            voucher,
            phone,
            dryRun,
            confirmation,
          }),
        });
        setTmnResult({ ...tmnResult, redemptionStatus: result.redemptionStatus });
        setNotice(result.message);
        setConfirmation("");
        await refresh();
      } catch (cause) {
        const latest = await requestJson<Overview>("/api/admin/overview").catch(
          () => null,
        );
        if (latest) {
          setOverview(latest);
          const row = latest.vouchers.find(
            (entry) => entry.id === tmnResult.transactionId,
          );
          if (row) {
            setTmnResult({
              ...tmnResult,
              redemptionStatus: String(row.redemption_status),
              responseCode:
                typeof row.response_code === "string" ? row.response_code : null,
            });
          }
        }
        throw cause;
      }
    });
  }

  async function logout() {
    setBusy(true);
    setError("");
    try {
      await requestJson("/api/admin/logout", { method: "POST" });
      setAuthenticated(false);
      setSettings(null);
      setOverview(null);
      setTmnResult(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out");
    } finally {
      setBusy(false);
    }
  }

  if (authenticated === null) {
    return <main className="mx-auto w-full max-w-3xl p-8 text-zinc-300">Loading…</main>;
  }

  if (!authenticated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-100">
        <form
          onSubmit={login}
          className="w-full max-w-md space-y-5 rounded-2xl border border-white/10 bg-zinc-900 p-8 shadow-2xl"
        >
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-400">
              Nova Store
            </p>
            <h1 className="mt-2 text-2xl font-semibold">xNearby Admin</h1>
            <p className="mt-2 text-sm text-zinc-400">
              Sign in to manage slip verification and TrueMoney operations.
            </p>
          </div>
          <label className="block text-sm text-zinc-300">
            Admin password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2 w-full rounded-lg border border-white/10 bg-zinc-950 px-3 py-2.5 outline-none focus:border-cyan-500"
              required
            />
          </label>
          {error && <p className="text-sm text-rose-300">{error}</p>}
          <button
            disabled={busy}
            className="w-full rounded-lg bg-cyan-500 px-4 py-2.5 font-semibold text-zinc-950 disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-white/10 bg-zinc-900/80">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">
              Nova Store · Integrations
            </p>
            <h1 className="mt-1 text-2xl font-semibold">xNearby API</h1>
          </div>
          <button
            onClick={logout}
            disabled={busy}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm text-zinc-200 hover:bg-white/5 disabled:opacity-50"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-7 px-5 py-7">
        {error && (
          <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
            {notice}
          </div>
        )}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatusCard label="Database" value={overview?.databaseConnected ? "Connected" : "Unavailable"} ok={overview?.databaseConnected ?? false} />
          <StatusCard label="API key" value={overview?.apiKeyConfigured ? "Configured" : "Missing"} ok={overview?.apiKeyConfigured ?? false} />
          <StatusCard label="Live redemption" value={overview?.liveRedeemEnabled ? "Explicit confirmation required" : "Disabled"} ok={false} />
          <StatusCard label="Remote health endpoint" value="Not documented" ok={false} />
        </section>

        <section id="configuration" className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
          <SectionHeading title="API Configuration" description="API key is read from the server environment and is never displayed here." />
          {settings && (
            <form onSubmit={saveSettings} className="mt-5 grid gap-4 md:grid-cols-2">
              <TextField
                label="Expected receiver name"
                value={settings.expected_receiver_name}
                onChange={(value) => setSettings({ ...settings, expected_receiver_name: value })}
              />
              <TextField
                label="Expected bank code or abbreviation"
                value={settings.expected_bank_code}
                onChange={(value) => setSettings({ ...settings, expected_bank_code: value })}
              />
              <TextField
                label="Expected account number (full or ending digits)"
                value={settings.expected_account_no}
                onChange={(value) => setSettings({ ...settings, expected_account_no: value })}
              />
              <div className="flex flex-wrap items-end gap-5">
                <Toggle label="Slip verification enabled" checked={settings.slip_enabled} onChange={(value) => setSettings({ ...settings, slip_enabled: value })} />
                <Toggle label="TrueMoney verify enabled" checked={settings.tmn_verify_enabled} onChange={(value) => setSettings({ ...settings, tmn_verify_enabled: value })} />
              </div>
              <div className="md:col-span-2">
                <button disabled={busy} className="rounded-lg bg-cyan-500 px-4 py-2.5 font-semibold text-zinc-950 disabled:opacity-50">
                  Save configuration
                </button>
              </div>
            </form>
          )}
        </section>

        <div className="grid gap-5 lg:grid-cols-2">
          <section id="slips" className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
            <SectionHeading title="Slip Verification" description="Create or use a basic order record and verify a single uploaded slip." />
            <form onSubmit={verifySlip} className="mt-5 space-y-4">
              <TextField label="Order reference" name="orderReference" required />
              <TextField label="Expected amount (THB)" name="amount" type="number" step="0.01" min="0.01" required />
              <label className="block text-sm text-zinc-300">
                Slip image (JPEG, PNG, WEBP · max 5 MB)
                <input
                  className="mt-2 block w-full rounded-lg border border-white/10 bg-zinc-950 p-2 text-sm"
                  type="file"
                  name="slip"
                  accept="image/jpeg,image/png,image/webp"
                  required
                />
              </label>
              <button disabled={busy} className="rounded-lg bg-cyan-500 px-4 py-2.5 font-semibold text-zinc-950 disabled:opacity-50">
                Verify slip
              </button>
            </form>
          </section>

          <section id="truemoney" className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
            <SectionHeading title="TrueMoney Wallet" description="Verify first. Redemption is a separate, admin-only operation." />
            <form onSubmit={verifyVoucher} className="mt-5 space-y-4">
              <TextField label="Voucher URL or code" value={voucher} onChange={setVoucher} required />
              <TextField label="TrueMoney phone number" value={phone} onChange={setPhone} inputMode="numeric" required />
              <button disabled={busy} className="rounded-lg bg-cyan-500 px-4 py-2.5 font-semibold text-zinc-950 disabled:opacity-50">
                Verify voucher
              </button>
            </form>

            {tmnResult && (
              <div className="mt-5 rounded-xl border border-white/10 bg-zinc-950 p-4 text-sm">
                <p className="font-semibold text-zinc-100">Voucher verification result</p>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-zinc-400">
                  <dt>Owner</dt><dd className="text-right text-zinc-200">{display(tmnResult.ownerName)}</dd>
                  <dt>Amount</dt><dd className="text-right text-zinc-200">฿{tmnResult.amount}</dd>
                  <dt>Available tickets</dt><dd className="text-right text-zinc-200">{tmnResult.availableTickets}</dd>
                  <dt>Voucher status</dt><dd className="text-right text-zinc-200">{tmnResult.providerStatus}{tmnResult.isExpired ? " · expired" : ""}</dd>
                </dl>

                <form onSubmit={redeem} className="mt-4 space-y-3 border-t border-white/10 pt-4">
                  <Toggle label="Dry run (no real funds received)" checked={dryRun} onChange={setDryRun} />
                  {!dryRun && (
                    <label className="block text-sm text-amber-200">
                      Live redemption is irreversible. Type REDEEM to confirm.
                      <input
                        value={confirmation}
                        onChange={(event) => setConfirmation(event.target.value)}
                        className="mt-2 w-full rounded-lg border border-amber-500/30 bg-zinc-900 px-3 py-2 text-zinc-100"
                        required
                      />
                    </label>
                  )}
                  <button
                    disabled={
                      busy ||
                      (!dryRun && !overview?.liveRedeemEnabled) ||
                      (!["NOT_REQUESTED", "DRY_RUN_SUCCEEDED", "DRY_RUN_FAILED"].includes(
                        tmnResult.redemptionStatus,
                      ) &&
                        !(
                          tmnResult.redemptionStatus === "FAILED" &&
                          [
                            "INVALID_API_KEY",
                            "INSUFFICIENT_BALANCE",
                            "INSUFFICIENT_PERMISSIONS",
                            "ENDPOINT_NOT_FOUND",
                            "HTTP_401",
                            "HTTP_402",
                            "HTTP_403",
                            "HTTP_404",
                          ].includes(tmnResult.responseCode ?? "")
                        ))
                    }
                    className="rounded-lg border border-amber-400/40 px-4 py-2.5 font-semibold text-amber-200 disabled:opacity-40"
                  >
                    {dryRun ? "Run dry test" : "Redeem voucher"}
                  </button>
                  {!overview?.liveRedeemEnabled && (
                    <p className="text-xs text-zinc-500">Live redemption is disabled by server configuration.</p>
                  )}
                </form>
              </div>
            )}
          </section>
        </div>

        <section id="transactions" className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
          <SectionHeading title="Payment & TrueMoney History" description="Sensitive voucher codes and complete account numbers are not shown." />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="text-xs uppercase text-zinc-500">
                <tr><th className="py-2">Order reference</th><th>Amount</th><th>Status</th><th>Provider transaction ID</th><th>Created</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {(overview?.payments ?? []).map((row) => (
                  <tr key={display(row.id)}>
                    <td className="py-3">{display(row.order_reference)}</td>
                    <td>{display(row.currency)} {display(row.amount)}</td>
                    <td><StatusPill value={display(row.status)} /></td>
                    <td className="font-mono">{display(row.provider_transaction_id ?? row.response_code)}</td>
                    <td>{display(row.created_at)}</td>
                  </tr>
                ))}
                {!overview?.payments.length && <tr><td className="py-4 text-zinc-500" colSpan={5}>No slip checks recorded.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="mt-7 overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="text-xs uppercase text-zinc-500">
                <tr><th className="py-2">Voucher</th><th>Phone</th><th>Amount</th><th>Verification</th><th>Redemption</th><th>Created</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {(overview?.vouchers ?? []).map((row) => (
                  <tr key={display(row.id)}>
                    <td className="py-3 font-mono">{display(row.voucher_hash)}</td>
                    <td>{display(row.phone_masked)}</td>
                    <td>{display(row.amount)}</td>
                    <td><StatusPill value={display(row.verification_status)} /></td>
                    <td><StatusPill value={display(row.redemption_status)} /></td>
                    <td>{display(row.created_at)}</td>
                  </tr>
                ))}
                {!overview?.vouchers.length && <tr><td className="py-4 text-zinc-500" colSpan={6}>No TrueMoney checks recorded.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section id="logs" className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
          <SectionHeading title="API Logs & Errors" description="Logs contain endpoint, status, duration, and provider error code only—not API keys, request bodies, slips, or voucher URLs." />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead className="text-xs uppercase text-zinc-500">
                <tr><th className="py-2">Endpoint</th><th>HTTP</th><th>Code</th><th>Duration</th><th>Time</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {(overview?.logs ?? []).map((row, index) => (
                  <tr key={`${display(row.created_at)}-${index}`}>
                    <td className="py-3 font-mono">{display(row.endpoint)}</td>
                    <td>{display(row.http_status)}</td>
                    <td>{display(row.response_code)}</td>
                    <td>{display(row.duration_ms)} ms</td>
                    <td>{display(row.created_at)}</td>
                  </tr>
                ))}
                {!overview?.logs.length && <tr><td className="py-4 text-zinc-500" colSpan={5}>No API requests yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section id="audit" className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
          <SectionHeading title="Admin Audit Trail" description="Configuration and transaction state changes are recorded without voucher or payment secrets." />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead className="text-xs uppercase text-zinc-500">
                <tr><th className="py-2">Actor</th><th>Action</th><th>Entity</th><th>Details</th><th>Time</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {(overview?.auditLogs ?? []).map((row, index) => (
                  <tr key={`${display(row.created_at)}-${index}`}>
                    <td className="py-3">{display(row.actor)}</td>
                    <td>{display(row.action)}</td>
                    <td>{display(row.entity_type)} · {display(row.entity_id)}</td>
                    <td>{JSON.stringify(row.details ?? {})}</td>
                    <td>{display(row.created_at)}</td>
                  </tr>
                ))}
                {!overview?.auditLogs.length && <tr><td className="py-4 text-zinc-500" colSpan={5}>No admin actions recorded.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <p className="pb-5 text-xs leading-5 text-zinc-500">
          This starter project has no customer login, checkout, or fulfillment service. A verified slip updates the basic order/payment records only; it does not deliver a product or add customer credit.
        </p>
      </div>
    </main>
  );
}

function StatusCard({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900 p-4">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-2 text-sm font-medium ${ok ? "text-emerald-300" : "text-amber-200"}`}>{value}</p>
    </div>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-zinc-400">{description}</p>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  name,
  type = "text",
  step,
  min,
  required = false,
  inputMode,
}: {
  label: string;
  value?: string;
  onChange?: (value: string) => void;
  name?: string;
  type?: string;
  step?: string;
  min?: string;
  required?: boolean;
  inputMode?: "numeric" | "text";
}) {
  return (
    <label className="block text-sm text-zinc-300">
      {label}
      <input
        name={name}
        type={type}
        step={step}
        min={min}
        inputMode={inputMode}
        value={value}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        className="mt-2 w-full rounded-lg border border-white/10 bg-zinc-950 px-3 py-2.5 text-zinc-100 outline-none focus:border-cyan-500"
        required={required}
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-cyan-500"
      />
      {label}
    </label>
  );
}

function StatusPill({ value }: { value: string }) {
  const tone =
    value === "PAID" || value === "VERIFIED" || value === "REDEEMED" || value === "DRY_RUN_SUCCEEDED"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
      : value === "UNKNOWN" || value === "REDEEMING" || value === "VERIFYING"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
        : value === "—"
          ? "border-white/10 bg-white/5 text-zinc-400"
          : "border-rose-500/30 bg-rose-500/10 text-rose-200";
  return <span className={`inline-flex rounded-full border px-2 py-1 text-xs ${tone}`}>{value}</span>;
}
