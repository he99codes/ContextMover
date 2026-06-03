// packages/web/src/app/config/selectors.json/route.ts
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This route serves the selectors in the exact format the browser extension expects.
// It reads from the 'platform_configs' table and transforms the data.

interface PlatformSelectors {
  messageSelector?: string;
  contentSelector?: string;
  userSelector?: string;
  assistantSelector?: string;
  inputSelector?: string;
  messageScope?: string;
  observerTarget?: string;
  scrollContainer?: string;
}

interface RemoteConfig {
  version: string;
  updatedAt: string;
  platforms: Record<string, PlatformSelectors>;
}

export async function GET() {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("platform_configs")
      .select("platform_id, selectors, last_updated_at");

    if (error) {
      // If the table doesn't exist yet, serve an empty config instead of failing.
      if ((error as { code?: string }).code === "42P01") {
        const empty: RemoteConfig = {
          version: "0",
          updatedAt: new Date().toISOString(),
          platforms: {},
        };
        return NextResponse.json(empty);
      }
      console.error("[Config Route] Supabase error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const platforms: Record<string, PlatformSelectors> = {};
    let newestTimestamp = 0;

    for (const row of data ?? []) {
      platforms[row.platform_id] = row.selectors as PlatformSelectors;
      const ts = new Date(row.last_updated_at as string).getTime();
      if (ts > newestTimestamp) {
        newestTimestamp = ts;
      }
    }

    const config: RemoteConfig = {
      version: String(newestTimestamp),
      updatedAt: new Date(newestTimestamp).toISOString(),
      platforms,
    };

    return NextResponse.json(config);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error("[Config Route] Internal Server Error:", err.message);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
