// packages/web/src/app/api/health/route.ts
// Comprehensive Supabase + Redis connectivity check.
// GET /api/health  → returns JSON report of every layer.
// Protected by requireAdmin — only admin session token works.
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/app/api/admin/_guard";
import { checkRateLimit } from "@/lib/rate-limiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// All tables the system depends on, with which client should be able to reach them
const TABLES = [
  { name: "sessions",             client: "service_role", schema: "public" },
  { name: "migrations",           client: "service_role", schema: "public" },
  { name: "custom_agents",        client: "service_role", schema: "public" },
  { name: "users",                client: "service_role", schema: "public" },
  { name: "subscriptions",        client: "service_role", schema: "public" },
  { name: "scraper_configs",      client: "service_role", schema: "public" },
  { name: "scraper_bug_reports",  client: "service_role", schema: "public" },
  { name: "usage_tracking",       client: "service_role", schema: "public" },
  { name: "usage_counters",       client: "service_role", schema: "public" },
  { name: "payment_events",       client: "service_role", schema: "public" },
] as const;

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  latencyMs?: number;
}

async function measureAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t };
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  // [SECURITY] Rate limit: 10/min per admin — health checks are expensive (DB + Redis probes).
  const rl = await checkRateLimit(req, guard.userId, 10);
  if (!rl.ok) return rl.response;

  const checks: Check[] = [];

  // ── 1. Env vars present ────────────────────────────────────────────────────
  const envVars = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  for (const v of envVars) {
    checks.push({
      name: `env:${v}`,
      ok: Boolean(process.env[v]),
      detail: process.env[v] ? "set" : "MISSING",
    });
  }

  // ── 2. Supabase URL reachable (raw fetch to /health) ──────────────────────
  {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (url) {
      const { result, ms } = await measureAsync(async () => {
        try {
          const r = await fetch(`${url}/rest/v1/`, {
            headers: {
              apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
              Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""}`,
            },
          });
          return { ok: r.status < 500, status: r.status };
        } catch (e) {
          return { ok: false, status: 0, error: String(e) };
        }
      });
      checks.push({
        name: "supabase:rest_reachable",
        ok: result.ok,
        detail: `HTTP ${result.status}`,
        latencyMs: ms,
      });
    }
  }

  // ── 3. Service-role client: can query each table ───────────────────────────
  let adminClient: ReturnType<typeof createAdminClient> | null = null;
  try {
    adminClient = createAdminClient();
    checks.push({ name: "supabase:admin_client_init", ok: true });
  } catch (e) {
    checks.push({ name: "supabase:admin_client_init", ok: false, detail: String(e) });
  }

  if (adminClient) {
    for (const table of TABLES) {
      const { result, ms } = await measureAsync(async () => {
        try {
          const { error, count } = await adminClient!
            .from(table.name)
            .select("*", { count: "exact", head: true });
          if (error) return { ok: false, detail: error.message };
          return { ok: true, detail: `count=${count ?? "?"}` };
        } catch (e) {
          return { ok: false, detail: String(e) };
        }
      });
      checks.push({
        name: `table:${table.name}`,
        ok: result.ok,
        detail: result.detail,
        latencyMs: ms,
      });
    }

    // ── 4. RLS sanity: anon key should NOT be able to read sessions ────────
    {
      const { result, ms } = await measureAsync(async () => {
        try {
          const { createClient } = await import("@supabase/supabase-js");
          const anonClient = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } }
          );
          const { data, error } = await anonClient.from("sessions").select("id").limit(1);
          if (error) {
            // RLS blocking → expected
            return { ok: true, detail: `RLS active: ${error.message}` };
          }
          if (!data || data.length === 0) {
            return { ok: true, detail: "RLS active: no rows returned to anon" };
          }
          return { ok: false, detail: `⚠️ RLS may be off — anon can read ${data.length} row(s)` };
        } catch (e) {
          return { ok: true, detail: `RLS blocked with exception: ${String(e)}` };
        }
      });
      checks.push({ name: "rls:sessions_anon_blocked", ok: result.ok, detail: result.detail, latencyMs: ms });
    }

    // ── 5. Auth: can list users (service role) ─────────────────────────────
    {
      const { result, ms } = await measureAsync(async () => {
        try {
          const { data, error } = await adminClient!.auth.admin.listUsers({ page: 1, perPage: 1 });
          if (error) return { ok: false, detail: error.message };
          return { ok: true, detail: `auth working, total≥${data.users.length}` };
        } catch (e) {
          return { ok: false, detail: String(e) };
        }
      });
      checks.push({ name: "supabase:auth_admin", ok: result.ok, detail: result.detail, latencyMs: ms });
    }
  }

  // ── 6. Upstash Redis ───────────────────────────────────────────────────────
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  checks.push({ name: "env:UPSTASH_REDIS_REST_URL", ok: Boolean(redisUrl), detail: redisUrl ? "set" : "MISSING" });
  checks.push({ name: "env:UPSTASH_REDIS_REST_TOKEN", ok: Boolean(redisToken), detail: redisToken ? "set" : "MISSING" });

  if (redisUrl && redisToken) {
    const { result, ms } = await measureAsync(async () => {
      try {
        const r = await fetch(`${redisUrl}/ping`, {
          headers: { Authorization: `Bearer ${redisToken}` },
        });
        const body = await r.json();
        return { ok: r.ok && body.result === "PONG", detail: JSON.stringify(body) };
      } catch (e) {
        return { ok: false, detail: String(e) };
      }
    });
    checks.push({ name: "redis:ping", ok: result.ok, detail: result.detail, latencyMs: ms });
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const failed = checks.filter(c => !c.ok);
  const summary = {
    ok: failed.length === 0,
    total: checks.length,
    passed: checks.filter(c => c.ok).length,
    failed: failed.length,
    failedChecks: failed.map(c => c.name),
    checkedAt: new Date().toISOString(),
    supabaseProject: process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/\/\/(.+?)\.supabase/)?.[1] ?? "unknown",
  };

  return NextResponse.json({ summary, checks }, {
    status: summary.ok ? 200 : 207,
  });
}
