/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/payments/pricing/route.ts
// Returns the geo-detected pricing config (no secret keys leaked).

import { NextRequest, NextResponse } from "next/server";
import { getPricingConfig } from "@/lib/payments/geo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const config = await getPricingConfig(req);
    return NextResponse.json({
      gateway:  config.gateway,
      currency: config.currency,
      symbol:   config.symbol,
      pro: {
        display:  config.pro.display,
        amount:   config.pro.amount,
        interval: config.pro.interval,
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
