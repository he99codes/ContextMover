import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limiter";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit(req, undefined, 20);
  if (!rl.ok) return rl.response;

  try {
    const body = (await req.json()) as {
      event?: string; platform?: string; detail?: string;
      timestamp?: number; extensionVersion?: string;
      sessionMessageCount?: number; tier?: number;
    };

    if (!body.event) {
      return NextResponse.json({ error: "Missing event" }, { status: 400 });
    }

    console.error("[CM:telemetry:event]", JSON.stringify({
      type: "extension_event", event: body.event, platform: body.platform ?? null,
      detail: body.detail ?? null, tier: body.tier ?? null,
      sessionMessageCount: body.sessionMessageCount ?? null,
      timestamp: body.timestamp ?? Date.now(), version: body.extensionVersion ?? "unknown",
    }));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[telemetry:event]", err);
    return NextResponse.json({ error: "Failed to log" }, { status: 500 });
  }
}
