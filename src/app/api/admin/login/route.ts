import { NextResponse } from "next/server";
import {
  assertSameOrigin,
  createAdminCookie,
  verifyAdminPassword,
} from "@/lib/admin-auth";
import { isJsonRecord, rateLimitResponse } from "@/lib/xnearby/admin-utils";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isJsonRecord(body) || typeof body.password !== "string") {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  if (body.password.length > 256) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  try {
    const limited = await rateLimitResponse("admin-login", 10, 300);
    if (limited) return limited;

    if (!verifyAdminPassword(body.password)) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const response = NextResponse.json({ authenticated: true });
    response.headers.set("Set-Cookie", createAdminCookie());
    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Admin authentication failed";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
