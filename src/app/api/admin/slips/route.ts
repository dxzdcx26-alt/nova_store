import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/admin-auth";
import { getPool, withTransaction } from "@/lib/db";
import {
  isJsonRecord,
  logApiRequest,
  rateLimitResponse,
  requireAdmin,
} from "@/lib/xnearby/admin-utils";
import {
  assertXNearbyConfigured,
  NearbyApiError,
  verifySlip,
} from "@/lib/xnearby/client";
import {
  detectSlipMime,
  maskAccountNumber,
  MAX_SLIP_BYTES,
  parseMoney,
  sha256,
} from "@/lib/xnearby/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (!assertSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  const limited = await rateLimitResponse("slip-verify", 10, 60);
  if (limited) return limited;

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_SLIP_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "Slip file is too large" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const file = form.get("slip");
  const orderReference = form.get("orderReference");
  const parsedAmount = parseMoney(form.get("amount"));
  if (
    !(file instanceof File) ||
    typeof orderReference !== "string" ||
    !orderReference.trim() ||
    orderReference.trim().length > 120 ||
    !parsedAmount
  ) {
    return NextResponse.json(
      { error: "Order reference, valid amount, and slip file are required" },
      { status: 400 },
    );
  }

  if (file.size < 1 || file.size > MAX_SLIP_BYTES) {
    return NextResponse.json(
      { error: `Slip must be no larger than ${MAX_SLIP_BYTES / 1024 / 1024} MB` },
      { status: 413 },
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "Could not read uploaded slip" }, { status: 400 });
  }

  const mimeType = detectSlipMime(bytes);
  if (!mimeType) {
    return NextResponse.json(
      { error: "Slip must be a valid JPEG, PNG, or WEBP image" },
      { status: 415 },
    );
  }

  let settings;
  try {
    const result = await getPool().query<{
      slip_enabled: boolean;
      expected_receiver_name: string;
      expected_bank_code: string;
      expected_account_no: string;
    }>(
      `SELECT slip_enabled, expected_receiver_name, expected_bank_code,
              expected_account_no
       FROM api_settings WHERE id = 1`,
    );
    settings = result.rows[0];
  } catch {
    return NextResponse.json(
      { error: "Database unavailable or xNearby migration has not been applied" },
      { status: 503 },
    );
  }

  if (!settings) {
    return NextResponse.json({ error: "xNearby settings are not initialized" }, { status: 503 });
  }
  if (!settings.slip_enabled) {
    return NextResponse.json({ error: "Slip verification is disabled" }, { status: 409 });
  }
  if (
    !settings.expected_receiver_name ||
    !settings.expected_bank_code ||
    !settings.expected_account_no
  ) {
    return NextResponse.json(
      { error: "Configure the expected receiver name, bank, and account first" },
      { status: 409 },
    );
  }

  try {
    assertXNearbyConfigured();
  } catch (error) {
    return NextResponse.json(
      {
        error: "xNearby API configuration is not ready",
        responseCode: error instanceof NearbyApiError ? error.code : "CONFIG_ERROR",
      },
      { status: 503 },
    );
  }

  const id = randomUUID();
  const slipHash = sha256(bytes);
  let orderId: string;
  try {
    await withTransaction(async (client) => {
      const existingOrder = await client.query<{
        id: string;
        amount: string;
        status: string;
      }>(
        `SELECT id, amount::text, status
         FROM orders WHERE order_reference = $1 FOR UPDATE`,
        [orderReference.trim()],
      );

      if (existingOrder.rows[0]) {
        const order = existingOrder.rows[0];
        const existingAmount = parseMoney(order.amount);
        if (!existingAmount || existingAmount.cents !== parsedAmount.cents) {
          throw new SlipReservationError(
            "ORDER_AMOUNT_MISMATCH",
            "Order amount does not match the recorded order",
          );
        }
        if (order.status === "PAID" || order.status === "PAYMENT_UNKNOWN") {
          throw new SlipReservationError(
            "ORDER_NOT_PAYABLE",
            "Order is already paid or has an unresolved payment",
          );
        }
        const activeAttempt = await client.query(
          `SELECT 1 FROM payment_transactions
           WHERE order_id = $1 AND status = 'VERIFYING'
           LIMIT 1`,
          [order.id],
        );
        if (activeAttempt.rowCount) {
          throw new SlipReservationError(
            "ORDER_VERIFICATION_IN_PROGRESS",
            "A payment verification is already in progress for this order",
          );
        }
        orderId = order.id;
        await client.query(
          `UPDATE orders SET status = 'PAYMENT_PENDING', updated_at = NOW()
           WHERE id = $1`,
          [orderId],
        );
      } else {
        orderId = randomUUID();
        await client.query(
          `INSERT INTO orders (id, order_reference, amount, status)
           VALUES ($1, $2, $3, 'PAYMENT_PENDING')`,
          [orderId, orderReference.trim(), parsedAmount.decimal],
        );
      }

      await client.query(
        `INSERT INTO payment_transactions
           (id, order_id, order_reference, amount, status)
         VALUES ($1, $2, $3, $4, 'VERIFYING')`,
        [id, orderId, orderReference.trim(), parsedAmount.decimal],
      );
      await client.query(
        `INSERT INTO slip_verifications
           (id, payment_transaction_id, slip_sha256, status)
         VALUES ($1, $2, $3, 'VERIFYING')`,
        [randomUUID(), id, slipHash],
      );
      await client.query(
         `INSERT INTO audit_logs (actor, action, entity_type, entity_id)
          VALUES ('admin', 'slip.verification.started', 'payment_transaction', $1)`,
         [id],
      );
    });
  } catch (error) {
    if (error instanceof SlipReservationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 409 },
      );
    }
    if (isJsonRecord(error) && error.code === "23505") {
      return NextResponse.json(
        { error: "This order or slip file has already been submitted" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "Could not create the payment verification record" },
      { status: 503 },
    );
  }

  const startedAt = Date.now();
  try {
    const response = await verifySlip(bytes, mimeType, {
      receiverName: settings.expected_receiver_name,
      bankCode: settings.expected_bank_code,
      accountNo: settings.expected_account_no,
    });
    const data = isJsonRecord(response.data) ? response.data : null;
    const receiver = data && isJsonRecord(data.receiver) ? data.receiver : null;
    const transId =
      data && typeof data.trans_id === "string" ? data.trans_id.trim() : "";
    const actualAmount = parseMoney(data?.amount);
    const receiverAccount =
      receiver && isJsonRecord(receiver.details) &&
      typeof receiver.details.account_no === "string"
        ? receiver.details.account_no
        : "";

    if (
      !data ||
      !receiver ||
      typeof receiver.name !== "string" ||
      !receiver.name.trim() ||
      typeof receiver.bank_code !== "string" ||
      !receiver.bank_code.trim() ||
      !receiverAccount ||
      !transId ||
      !actualAmount
    ) {
      await setSlipState(id, "UNKNOWN", "INVALID_RESPONSE");
      await logApiRequest({
        endpoint: "/slipVerify/v2",
        httpStatus: 200,
        responseCode: "INVALID_RESPONSE",
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        {
          error: "xNearby response was incomplete; payment was not marked paid",
          paymentId: id,
          status: "UNKNOWN",
        },
        { status: 502 },
      );
    }

    const amountMatches = actualAmount.cents === parsedAmount.cents;
    const status = amountMatches ? "VERIFIED" : "REJECTED";
    const paymentStatus = amountMatches ? "PAID" : "REJECTED";
    const responseCode = amountMatches ? null : "AMOUNT_MISMATCH";

    try {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE slip_verifications
           SET provider_transaction_id = $2,
               actual_amount = $3,
               receiver_name = $4,
               receiver_bank_code = $5,
               receiver_account_no_masked = $6,
               response_code = $7,
               status = $8,
               verified_at = NOW()
           WHERE payment_transaction_id = $1`,
          [
            id,
            transId,
            actualAmount.decimal,
            typeof receiver.name === "string" ? receiver.name : null,
            typeof receiver.bank_code === "string" ? receiver.bank_code : null,
            maskAccountNumber(receiverAccount),
            responseCode,
            status,
          ],
        );
        await client.query(
          `UPDATE payment_transactions
           SET provider_transaction_id = $2, status = $3,
               response_code = $4, updated_at = NOW()
           WHERE id = $1`,
          [id, transId, paymentStatus, responseCode],
        );
        await client.query(
          `UPDATE orders
           SET status = $2, updated_at = NOW()
           WHERE id = (SELECT order_id FROM payment_transactions WHERE id = $1)`,
          [
            id,
            amountMatches ? "PAID" : "PAYMENT_REJECTED",
          ],
        );
        await client.query(
          `INSERT INTO audit_logs (actor, action, entity_type, entity_id, details)
           VALUES ('admin', 'slip.verification.completed', 'payment_transaction', $1, $2::jsonb)`,
          [
            id,
            JSON.stringify({
              status: paymentStatus,
              responseCode,
              amountMatches,
            }),
          ],
        );
      });
    } catch (error) {
      if (isJsonRecord(error) && error.code === "23505") {
        await setSlipState(id, "REJECTED", "DUPLICATE_TRANSACTION");
        await logApiRequest({
          endpoint: "/slipVerify/v2",
          httpStatus: 200,
          responseCode: "DUPLICATE_TRANSACTION",
          durationMs: Date.now() - startedAt,
        });
        return NextResponse.json(
          {
            error: "This provider transaction has already been recorded",
            paymentId: id,
            status: "REJECTED",
          },
          { status: 409 },
        );
      }
      throw error;
    }

    await logApiRequest({
      endpoint: "/slipVerify/v2",
      httpStatus: 200,
      responseCode,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        paymentId: id,
        orderReference: orderReference.trim(),
        amount: parsedAmount.decimal,
        status: paymentStatus,
        responseCode,
      },
      { status: amountMatches ? 200 : 422 },
    );
  } catch (error) {
    const apiError =
      error instanceof NearbyApiError
        ? error
        : new NearbyApiError("Could not save xNearby result", "STORAGE_ERROR", null, true);
    const state = apiError.outcomeUnknown
      ? "UNKNOWN"
      : apiError.httpStatus === 400
        ? "REJECTED"
        : "FAILED";

    await setSlipState(id, state, apiError.code);
    await logApiRequest({
      endpoint: "/slipVerify/v2",
      httpStatus: apiError.httpStatus,
      responseCode: apiError.code,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        error: "Slip verification did not complete; payment was not marked paid",
        paymentId: id,
        status: state,
        responseCode: apiError.code,
      },
      { status: apiError.httpStatus === 400 ? 422 : 502 },
    );
  }
}

async function setSlipState(
  paymentId: string,
  status: "REJECTED" | "FAILED" | "UNKNOWN",
  responseCode: string,
) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE slip_verifications
       SET status = $2, response_code = $3, verified_at = NOW()
       WHERE payment_transaction_id = $1`,
      [paymentId, status, responseCode],
    );
    await client.query(
      `UPDATE payment_transactions
       SET status = $2, response_code = $3, updated_at = NOW()
       WHERE id = $1`,
      [paymentId, status, responseCode],
    );
    const orderStatus =
      status === "UNKNOWN"
        ? "PAYMENT_UNKNOWN"
        : status === "REJECTED"
          ? "PAYMENT_REJECTED"
          : "PAYMENT_FAILED";
    await client.query(
      `UPDATE orders
       SET status = $2, updated_at = NOW()
       WHERE id = (SELECT order_id FROM payment_transactions WHERE id = $1)`,
      [paymentId, orderStatus],
    );
    await client.query(
      `INSERT INTO audit_logs (actor, action, entity_type, entity_id, details)
       VALUES ('admin', 'slip.verification.failed', 'payment_transaction', $1, $2::jsonb)`,
      [paymentId, JSON.stringify({ status, responseCode })],
    );
  });
}

class SlipReservationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SlipReservationError";
  }
}
