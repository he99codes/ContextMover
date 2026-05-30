import { NextResponse } from "next/server";
import { selectorsConfig } from "@/data/selectors";

export const runtime = "nodejs";

/**
 * Public config endpoint for extension selector + injection strategy overrides.
 *
 * Cache strategy:
 *   - max-age=3600        → Vercel edge cache + browser cache for 1 hour
 *   - stale-while-revalidate=86400 → serve stale for up to 24h while revalidating
 *
 * The extension fetches this every hour (CACHE_TTL = 60 min), so the cache
 * alignment is exact. On a hotfix deploy the stale-while-revalidate window
 * means users see the update within an hour.
 */
export async function GET() {
  try {
    return NextResponse.json(selectorsConfig, {
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to load config" },
      { status: 500 }
    );
  }
}
