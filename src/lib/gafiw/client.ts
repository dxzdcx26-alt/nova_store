export type GafiwProduct = {
  type_id: string;
  name: string;
  imageapi: string | null;
  price: number;
  pricevip: number;
  stock: number;
  type_menu: string;
  details: string;
};

export type GafiwHistoryItem = {
  id?: string | number;
  name?: string;
  details?: string;
  price?: number | string;
  status?: number | string;
  date?: string;
};

export class GafiwApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number | null,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "GafiwApiError";
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function request(
  path: string,
  init: RequestInit,
  timeoutMs = 10_000,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://gafiwshop.xyz/api/${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    const timeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new GafiwApiError(
      timeout ? "GAFIW request timed out" : "Could not reach GAFIW Shop",
      timeout ? "TIMEOUT" : "NETWORK_ERROR",
      null,
      true,
    );
  }

  let payload: unknown;
  try {
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("Response too large");
    payload = JSON.parse(text);
  } catch {
    throw new GafiwApiError(
      "GAFIW returned an invalid response",
      "INVALID_RESPONSE",
      response.status,
      true,
    );
  }

  if (!response.ok) {
    const code = errorCode(payload) ?? `HTTP_${response.status}`;
    throw new GafiwApiError(
      "GAFIW rejected the request",
      code,
      response.status,
      response.status >= 500 || response.status === 408 || response.status === 429,
    );
  }

  return payload;
}

function errorCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const error = isRecord(payload.error) ? payload.error : null;
  const candidate = error?.code ?? payload.code;
  return typeof candidate === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(candidate)
    ? candidate
    : null;
}

function rejectApiError(payload: unknown): void {
  if (Array.isArray(payload)) return;
  if (!isRecord(payload)) {
    throw new GafiwApiError("GAFIW returned an invalid response", "INVALID_RESPONSE", 200);
  }
  if (payload.ok === false || payload.status === "error") {
    throw new GafiwApiError(
      "GAFIW reported an API error",
      errorCode(payload) ?? "PROVIDER_ERROR",
      200,
    );
  }
}

function parseProduct(value: unknown): GafiwProduct {
  if (!isRecord(value)) {
    throw new GafiwApiError("GAFIW product data is invalid", "INVALID_PRODUCT", 200);
  }

  const {
    type_id: typeId,
    name,
    imageapi: image,
    price,
    pricevip: priceVip,
    stock,
    type_menu: category,
    details,
  } = value;
  if (
    typeof typeId !== "string" ||
    !typeId.trim() ||
    typeof name !== "string" ||
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    price < 0 ||
    typeof priceVip !== "number" ||
    !Number.isFinite(priceVip) ||
    priceVip < 0 ||
    typeof stock !== "number" ||
    !Number.isSafeInteger(stock) ||
    stock < 0 ||
    typeof category !== "string"
  ) {
    throw new GafiwApiError("GAFIW product fields are invalid", "INVALID_PRODUCT", 200);
  }

  return {
    type_id: typeId.trim(),
    name: name.slice(0, 200),
    imageapi: safeImageUrl(image),
    price,
    pricevip: priceVip,
    stock,
    type_menu: category.slice(0, 100),
    details: typeof details === "string" ? details.slice(0, 20_000) : "",
  };
}

function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "gafiwshop.xyz"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export async function fetchProducts(): Promise<GafiwProduct[]> {
  const payload = await request("api_product", { method: "GET" });
  if (!isRecord(payload) || payload.ok !== true || !Array.isArray(payload.data)) {
    throw new GafiwApiError(
      "GAFIW Product API response is invalid",
      errorCode(payload) ?? "INVALID_RESPONSE",
      200,
    );
  }
  return payload.data.map(parseProduct);
}

function apiErrorStatus(payload: unknown): boolean {
  if (!isRecord(payload)) return true;
  return payload.status === "success" || payload.ok === true;
}

function historyRows(payload: unknown): GafiwHistoryItem[] {
  rejectApiError(payload);
  if (Array.isArray(payload)) {
    return payload.filter(isRecord) as GafiwHistoryItem[];
  }
  if (isRecord(payload) && Array.isArray(payload.data)) {
    return payload.data.filter(isRecord) as GafiwHistoryItem[];
  }
  if (isRecord(payload) && isRecord(payload.data)) {
    return [payload.data as GafiwHistoryItem];
  }
  if (isRecord(payload) && apiErrorStatus(payload) && payload.data === undefined) {
    return [];
  }
  throw new GafiwApiError(
    "GAFIW History API response is invalid",
    "INVALID_RESPONSE",
    200,
  );
}

export async function fetchHistory(input: {
  apiKey: string;
  limit: number;
  username?: string;
}): Promise<GafiwHistoryItem[]> {
  const params = new URLSearchParams({
    keyapi: input.apiKey,
    limit: String(input.limit),
  });
  if (input.username) params.set("username_buy", input.username);
  return historyRows(
    await request(`api_history?${params.toString()}`, { method: "GET" }),
  );
}

export async function buyProduct(input: {
  apiKey: string;
  typeId: string;
  username?: string;
}): Promise<JsonRecord> {
  const form = new URLSearchParams({
    keyapi: input.apiKey,
    type_id: input.typeId,
  });
  if (input.username) form.set("username_buy", input.username);
  const payload = await request("api_buy", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  rejectApiError(payload);
  if (!isRecord(payload) || payload.status !== "success") {
    throw new GafiwApiError(
      "GAFIW purchase was not confirmed",
      errorCode(payload) ?? "PURCHASE_NOT_CONFIRMED",
      200,
      true,
    );
  }
  return payload;
}

export async function submitClaim(input: {
  apiKey: string;
  orderId: string;
  reason: string;
}): Promise<JsonRecord> {
  const form = new URLSearchParams({
    keyapi: input.apiKey,
    order_id: input.orderId,
    reason: input.reason,
  });
  const payload = await request("api_claim", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  rejectApiError(payload);
  if (!isRecord(payload) || payload.status !== "success") {
    throw new GafiwApiError(
      "GAFIW did not confirm the claim submission",
      errorCode(payload) ?? "CLAIM_NOT_CONFIRMED",
      200,
      true,
    );
  }
  return payload;
}

export async function checkClaimStatus(input: {
  apiKey: string;
  orderId?: string;
}): Promise<unknown[]> {
  const form = new URLSearchParams({ keyapi: input.apiKey });
  if (input.orderId) form.set("order_id", input.orderId);
  const payload = await request("v1/check_claim_status.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  rejectApiError(payload);
  if (!isRecord(payload) || !apiErrorStatus(payload)) {
    throw new GafiwApiError(
      "GAFIW Claim Status response is invalid",
      errorCode(payload) ?? "INVALID_RESPONSE",
      200,
    );
  }
  if (Array.isArray(payload.data)) return payload.data;
  if (isRecord(payload.data)) return [payload.data];
  return [];
}
