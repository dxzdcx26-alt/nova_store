type JsonRecord = Record<string, unknown>;

export class NearbyApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number | null,
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
    this.name = "NearbyApiError";
  }
}

function getConfig() {
  const apiKey = process.env.XNEARBY_API_KEY;
  if (!apiKey) {
    throw new NearbyApiError(
      "xNearby API is not configured",
      "MISSING_API_KEY",
      null,
      false,
    );
  }

  const timeout = Number(process.env.XNEARBY_TIMEOUT_MS ?? "10000");
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 60_000) {
    throw new NearbyApiError(
      "xNearby timeout configuration is invalid",
      "INVALID_TIMEOUT_CONFIG",
      null,
      false,
    );
  }

  return { apiKey, timeout };
}

export function assertXNearbyConfigured() {
  getConfig();
}

async function post(
  path: "/slipVerify/v2" | "/tmn/verify" | "/tmn/redeem",
  init: RequestInit,
  requireSuccessFlag = false,
): Promise<JsonRecord> {
  const { apiKey, timeout } = getConfig();
  let response: Response;

  try {
    response = await fetch(`https://api.nearbyshop.xyz${path}`, {
      ...init,
      headers: {
        ...init.headers,
        "X-API-Key": apiKey,
      },
      signal: AbortSignal.timeout(timeout),
      cache: "no-store",
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new NearbyApiError(
      timedOut ? "xNearby request timed out" : "Could not reach xNearby",
      timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      null,
      true,
    );
  }

  let payload: unknown;
  try {
    const text = await response.text();
    if (text.length > 1_000_000) {
      throw new Error("Response too large");
    }
    payload = JSON.parse(text);
  } catch {
    throw new NearbyApiError(
      "xNearby returned an invalid response",
      "INVALID_RESPONSE",
      response.status,
      true,
    );
  }

  const record =
    payload && typeof payload === "object"
      ? (payload as JsonRecord)
      : null;
  if (!response.ok || record?.status !== "success") {
    const candidateCode =
      typeof record?.code === "string" ? record.code : `HTTP_${response.status}`;
    const code = /^[A-Za-z0-9_-]{1,80}$/.test(candidateCode)
      ? candidateCode
      : "PROVIDER_ERROR";
    throw new NearbyApiError(
      "xNearby rejected the request",
      code,
      response.status,
      response.status >= 500 ||
        response.status === 429 ||
        response.status === 408 ||
        response.status === 200,
    );
  }

  if (requireSuccessFlag && record.success !== true) {
    throw new NearbyApiError(
      "xNearby returned an unsuccessful TrueMoney response",
      "INVALID_RESPONSE",
      response.status,
      true,
    );
  }

  return record;
}

export async function verifySlip(
  bytes: Uint8Array,
  mimeType: string,
  expected: {
    receiverName: string;
    bankCode: string;
    accountNo: string;
  },
): Promise<JsonRecord> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  const extension =
    mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  form.append("slip", blob, `slip.${extension}`);
  form.append("expected_receiver_name", expected.receiverName);
  form.append("expected_bank_code", expected.bankCode);
  form.append("expected_account_no", expected.accountNo);
  return post("/slipVerify/v2", { method: "POST", body: form });
}

export async function verifyVoucher(voucher: string, phone: string) {
  return post(
    "/tmn/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voucher, phone }),
    },
    true,
  );
}

export async function redeemVoucher(
  voucher: string,
  phone: string,
  dryRun: boolean,
) {
  return post(
    "/tmn/redeem",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voucher, phone, dryRun }),
    },
    true,
  );
}
