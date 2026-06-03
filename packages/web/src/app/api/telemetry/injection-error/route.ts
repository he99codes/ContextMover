import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limiter";
import { sanitizeTelemetry } from "@/lib/telemetry-sanitizer";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit(req, undefined, 10);
  if (!rl.ok) return rl.response;

  try {
    const body = (await req.json()) as {
      platform?: string; reason?: string; href?: string;
      timestamp?: number; extensionVersion?: string;
      tier?: number; strategy?: string;
    };

    if (!body.platform || !body.reason) {
      return NextResponse.json({ error: "Missing platform or reason" }, { status: 400 });
    }

    const sanitizedBody = sanitizeTelemetry(body);
    console.error("[CM:telemetry:injection]", JSON.stringify({ type: "injection_error", ...sanitizedBody }));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[telemetry:injection]", err);
    return NextResponse.json({ error: "Failed to log" }, { status: 500 });
  }
}
