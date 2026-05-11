// packages/web/src/app/api/payments/pricing/route.ts
// Returns the geo-detected pricing config (no secret keys leaked).

import { NextResponse } from "next/server";
import { getPricingConfig } from "@/lib/payments/geo";

export async function GET() {
  try {
    const config = await getPricingConfig();
    return NextResponse.json({
      gateway:  config.gateway,
      currency: config.currency,
      symbol:   config.symbol,
      pro: {
        display:  config.pro.display,
        amount:   config.pro.amount,
        interval: config.pro.interval,
      },
      team: {
        display:  config.team.display,
        amount:   config.team.amount,
        interval: config.team.interval,
      },
    });
  } catch (err) {
    console.error("[CM:api:pricing] error:", err);
    return NextResponse.json(
      { error: "Failed to detect pricing" },
      { status: 500 }
    );
  }
}
