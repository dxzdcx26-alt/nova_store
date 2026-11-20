"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type Settings = {
  enabled: boolean;
  connection_status: "CONNECTED" | "DISCONNECTED" | "ERROR";
  last_tested_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  updated_at: string;
  api_key_configured: boolean;
};

type HistoryItem = {
  id?: string | number;
  name?: string;
  details?: string;
  price?: number | string;
  status?: number | string;
  date?: string;
};

type Claim = {
  order_id: string;
  reason: string;
  submission_status: string;
  claim_time: string | null;
  claim_status: string | null;
  claim_text: string | null;
  response_code: string | null;
  created_at: string;
};

type ApiLog = {
  endpoint: string;
  http_status: number | null;
  response_code: string | null;
  duration_ms: number;
  created_at: string;
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

function value(value: unknown) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

export default function GafiwAdminPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [logs, setLogs] = useState<ApiLog[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [username, setUsername] = useState("");
  const [claimOrderId, setClaimOrderId] = useState("");
  const [claimReason, setClaimReason] = useState("");
  const [claimStatusOrderId, setClaimStatusOrderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [nextSettings, nextLogs, nextClaims] = await Promise.all([
      requestJson<Settings>("/api/admin/gafiw/settings"),
      requestJson<{ logs: ApiLog[] }>("/api/admin/gafiw/logs"),
      requestJson<{ claims: Claim[] }>("/api/admin/gafiw/claims"),
    ]);
    setSettings(nextSettings);
    setLogs(nextLogs.logs);
    setClaims(nextClaims.claims);
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
      await requestJson("/api/admin/gafiw/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: settings.enabled,
          ...(apiKey.trim() ? { apiKey } : {}),
        }),
      });
      setApiKey("");
      setNotice("GAFIW settings saved. The API key is never returned to the browser.");
      await refresh();
    });
  }

  async function clearApiKey() {
    if (!settings) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await requestJson("/api/admin/gafiw/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false, clearApiKey: true }),
      });
      setApiKey("");
      setNotice("API key cleared and GAFIW disabled.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not clear the key");
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await requestJson<{ connected: boolean; historyRecords: number }>(
        "/api/admin/gafiw/test",
        { method: "POST" },
      );
      setNotice(`Connected. History API returned ${result.historyRecords} record(s).`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connection test failed");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function syncProducts() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await requestJson<{ synced: number }>("/api/admin/gafiw/products", {
        method: "POST",
      });
      setNotice(`${result.synced} products synchronized from the live Product API.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Product sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadHistory(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      const params = new URLSearchParams({ limit: "50" });
      if (username.trim()) params.set("username", username.trim());
      const result = await requestJson<{ history: HistoryItem[] }>(
        `/api/admin/gafiw/history?${params.toString()}`,
      );
      setHistory(result.history);
      setNotice(`${result.history.length} history record(s) loaded.`);
    });
  }

  async function fileClaim(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await requestJson("/api/admin/gafiw/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: claimOrderId, reason: claimReason }),
      });
      setClaimReason("");
      setNotice("Claim request submitted. Submission does not mean approval or refund.");
      await refresh();
    });
  }

  async function checkClaimStatus(event: FormEvent<HTMLFormElement>) {
    await submit(event, async () => {
      await requestJson("/api/admin/gafiw/claim-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(claimStatusOrderId.trim()
            ? { orderId: claimStatusOrderId.trim() }
            : {}),
        }),
      });
      setNotice("Claim statuses synchronized. No claim request was submitted.");
      await refresh();
    });
  }

  async function logout() {
    setBusy(true);
    try {
      await requestJson("/api/admin/logout", { method: "POST" });
      setAuthenticated(false);
      setSettings(null);
      setHistory([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not log out");
    } finally {
      setBusy(false);
    }
  }

  if (authenticated === null) {
    return <main className="p-8 text-zinc-300">Checking admin session…</main>;
  }

  if (!authenticated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-100">
        <form onSubmit={login} className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <div>
            <p className="text-sm text-cyan-400">NOVA STORE / ADMIN</p>
            <h1 className="mt-2 text-2xl font-semibold">GAFIW Integration</h1>
          </div>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Admin password"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
            required
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button disabled={busy} className="w-full rounded-lg bg-cyan-600 px-4 py-2 font-medium disabled:opacity-50">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium tracking-wide text-cyan-400">NOVA STORE / ADMIN</p>
            <h1 className="mt-1 text-3xl font-semibold">GAFIW Shop API</h1>
            <p className="mt-1 text-sm text-zinc-400">Server-side API configuration, catalog, history and claim tools.</p>
          </div>
          <div className="flex gap-2">
            <a href="/admin/xnearby" className="rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800">xNearby</a>
            <button onClick={logout} disabled={busy} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800">Sign out</button>
          </div>
        </header>

        {(notice || error) && (
          <div className={`rounded-lg border px-4 py-3 text-sm ${error ? "border-red-900 bg-red-950/50 text-red-300" : "border-emerald-900 bg-emerald-950/40 text-emerald-300"}`}>
            {error || notice}
          </div>
        )}

        <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <form onSubmit={saveSettings} className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">API Configuration</h2>
                <p className="mt-1 text-sm text-zinc-400">API key is encrypted at rest and never sent back to this page.</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${settings?.connection_status === "CONNECTED" ? "bg-emerald-950 text-emerald-300" : settings?.connection_status === "ERROR" ? "bg-red-950 text-red-300" : "bg-zinc-800 text-zinc-300"}`}>
                {settings?.connection_status ?? "DISCONNECTED"}
              </span>
            </div>
            <label className="block text-sm text-zinc-300">
              API Key {settings?.api_key_configured && <span className="text-emerald-400">(configured)</span>}
              <div className="mt-1 flex gap-2">
                <input
                  type={showKey ? "text" : "password"}
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={settings?.api_key_configured ? "Enter a new key to replace the saved key" : "Paste API key"}
                  className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
                />
                <button type="button" onClick={() => setShowKey((shown) => !shown)} className="rounded-lg border border-zinc-700 px-3 text-sm">
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings?.enabled ?? false}
                onChange={(event) => setSettings((current) => current ? { ...current, enabled: event.target.checked } : current)}
              />
              Enable GAFIW API features
            </label>
            <div className="flex flex-wrap gap-2">
              <button disabled={busy} className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium disabled:opacity-50">Save settings</button>
              <button type="button" disabled={busy} onClick={testConnection} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm disabled:opacity-50">Test connection</button>
              <button type="button" disabled={busy || !settings?.api_key_configured} onClick={clearApiKey} className="rounded-lg border border-red-900 px-4 py-2 text-sm text-red-300 disabled:opacity-50">Clear key</button>
            </div>
            <p className="text-xs text-zinc-500">
              Last tested: {value(settings?.last_tested_at)} {settings?.last_error_code ? `· ${settings.last_error_code}: ${settings.last_error_message}` : ""}
            </p>
          </form>

          <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
            <div>
              <h2 className="text-lg font-semibold">Product Management</h2>
              <p className="mt-1 text-sm text-zinc-400">Sync the live Product API into the local catalog. This does not make purchases.</p>
            </div>
            <button disabled={busy} onClick={syncProducts} className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-50">Sync products now</button>
            <div className="rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-sm text-amber-200">
              Purchase is intentionally unavailable until this project has real member ownership, payment confirmation, and order fulfillment.
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
            <div>
              <h2 className="text-lg font-semibold">Purchase History</h2>
              <p className="text-sm text-zinc-400">Fetched from GAFIW on demand; details may contain sensitive delivery data.</p>
            </div>
            <form onSubmit={loadHistory} className="flex flex-wrap gap-2">
              <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="username_buy (optional)" className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" />
              <button disabled={busy} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm">Load history</button>
            </form>
            <div className="max-h-96 space-y-3 overflow-auto">
              {history.map((item, index) => (
                <article key={`${item.id ?? "history"}-${index}`} className="rounded-lg border border-zinc-800 p-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>{value(item.name)}</strong>
                    <span className="text-zinc-400">ID {value(item.id)} · Status {value(item.status)}</span>
                  </div>
                  <p className="mt-1 text-zinc-400">{value(item.date)} · {value(item.price)}</p>
                  {item.details && <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-zinc-950 p-2 text-xs text-zinc-300">{item.details}</pre>}
                  {item.id !== undefined && <button type="button" onClick={() => setClaimOrderId(String(item.id))} className="mt-2 text-xs text-cyan-300 hover:underline">Use for claim</button>}
                </article>
              ))}
              {history.length === 0 && <p className="text-sm text-zinc-500">No history loaded.</p>}
            </div>
          </div>

          <div className="space-y-5 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
            <div>
              <h2 className="text-lg font-semibold">Claim Management</h2>
              <p className="text-sm text-zinc-400">Admin-only tools. Sending a claim is not a refund or approval.</p>
            </div>
            <form onSubmit={fileClaim} className="space-y-2">
              <input value={claimOrderId} onChange={(event) => setClaimOrderId(event.target.value)} placeholder="Order ID" required className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" />
              <textarea value={claimReason} onChange={(event) => setClaimReason(event.target.value)} placeholder="Claim reason" required rows={3} className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" />
              <button disabled={busy} className="rounded-lg bg-amber-700 px-4 py-2 text-sm disabled:opacity-50">Submit claim once</button>
            </form>
            <form onSubmit={checkClaimStatus} className="flex flex-wrap gap-2 border-t border-zinc-800 pt-4">
              <input value={claimStatusOrderId} onChange={(event) => setClaimStatusOrderId(event.target.value)} placeholder="Order ID (blank checks all)" className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" />
              <button disabled={busy} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm">Check status</button>
            </form>
            <div className="max-h-56 space-y-2 overflow-auto">
              {claims.map((claim) => (
                <article key={claim.order_id} className="rounded-lg border border-zinc-800 p-3 text-xs">
                  <div className="flex justify-between gap-2"><strong>{claim.order_id}</strong><span>{claim.submission_status}</span></div>
                  <p className="mt-1 text-zinc-400">{value(claim.claim_status)} · {value(claim.claim_text)} · {value(claim.claim_time)}</p>
                </article>
              ))}
              {claims.length === 0 && <p className="text-sm text-zinc-500">No local claim records.</p>}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <h2 className="text-lg font-semibold">API Request & Error Logs</h2>
          <p className="mb-3 text-sm text-zinc-400">Logs contain endpoint names, status codes, duration and timestamps only; no API key or response body.</p>
          <div className="overflow-auto">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead className="text-xs uppercase text-zinc-500"><tr><th className="py-2">Time</th><th>Endpoint</th><th>HTTP</th><th>Code</th><th>Duration</th></tr></thead>
              <tbody>{logs.map((log, index) => <tr key={`${log.created_at}-${index}`} className="border-t border-zinc-800"><td className="py-2 pr-3">{new Date(log.created_at).toLocaleString()}</td><td className="pr-3">{log.endpoint}</td><td className="pr-3">{value(log.http_status)}</td><td className="pr-3">{value(log.response_code)}</td><td>{log.duration_ms} ms</td></tr>)}</tbody>
            </table>
            {logs.length === 0 && <p className="py-3 text-sm text-zinc-500">No API requests recorded.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
