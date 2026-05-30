import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limiter";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit(req, undefined, 10);
  if (!rl.ok) return rl.response;

  try {
    const body = (await req.json()) as {
      platform?: string; reason?: string; href?: string;
      timestamp?: number; extensionVersion?: string; selector?: string;
    };

    if (!body.platform || !body.reason) {
      return NextResponse.json({ error: "Missing platform or reason" }, { status: 400 });
    }

    console.error("[CM:telemetry:scraper]", JSON.stringify({
      type: "scraper_error", platform: body.platform, reason: body.reason,
      href: body.href ?? null, selector: body.selector ?? null,
      timestamp: body.timestamp ?? Date.now(), version: body.extensionVersion ?? "unknown",
    }));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[telemetry:scraper]", err);
    return NextResponse.json({ error: "Failed to log" }, { status: 500 });
  }
}
