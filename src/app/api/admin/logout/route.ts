import { NextResponse } from "next/server";
import { assertSameOrigin, clearAdminCookie } from "@/lib/admin-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  const response = NextResponse.json({ authenticated: false });
  response.headers.set("Set-Cookie", clearAdminCookie());
  return response;
}
