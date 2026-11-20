import { NextResponse } from "next/server";
import { fetchHistory } from "@/lib/gafiw/client";
import {
  callGafiwLogged,
  gafiwErrorResponse,
  getGafiwApiKey,
} from "@/lib/gafiw/server";
import { requireAdmin } from "@/lib/xnearby/admin-utils";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const rawLimit = Number(params.get("limit") ?? "20");
  const username = (params.get("username") ?? "").trim();
  if (
    !Number.isInteger(rawLimit) ||
    rawLimit < 1 ||
    rawLimit > 100 ||
    username.length > 100
  ) {
    return NextResponse.json({ error: "Invalid history filters" }, { status: 400 });
  }
  try {
    const apiKey = await getGafiwApiKey();
    const history = await callGafiwLogged("/api_history", () =>
      fetchHistory({ apiKey, limit: rawLimit, username: username || undefined }),
    );
    return NextResponse.json({ history });
  } catch (error) {
    return gafiwErrorResponse(error);
  }
}
