"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

interface Stats { total_users: number; pro_users: number; total_migrations: number; migrations_this_month: number; open_bug_reports: number; platform_breakdown: Record<string, number>; tier_breakdown?: Record<string, number>; }
interface AdminUser { id: string; email: string; created_at: string; plan: string; subscription_status: string | null; tier1_used: number; tier2_used: number; tier3_used: number; }
interface BugReport { id: string; email: string | null; severity: string; description: string; version: string | null; created_at: string; }
interface RefundRequest { id: string; email: string | null; payment_id: string | null; reason: string; status: string; created_at: string; }
interface FoundUser { id: string; email: string; created_at: string; plan: string; status: string | null; tier1_count: number; tier2_count: number; tier3_count: number; }

interface UsageRow { month: string; tier1_count: number; tier2_count: number; tier3_count: number; simple_migrations: number; smart_migrations: number; attention_migrations: number; sessions_count: number; updated_at: string | null; }
interface SubscriptionRow { plan: string; status: string; gateway: string | null; interval: string | null; amount: number | null; currency: string | null; current_period_start: string | null; current_period_end: string | null; cancelled_at: string | null; trial_end: string | null; created_at: string | null; updated_at: string | null; }
interface PaymentEventRow { event_type: string; gateway: string | null; gateway_event_id: string | null; amount: number | null; currency: string | null; created_at: string; payload: unknown; }
interface AuthUserInfo { email: string | null; created_at: string | null; last_sign_in_at: string | null; provider: string | null; }
interface MigrationRow { tier: number; source_platform: string | null; target_platform: string | null; message_count: number; char_count: number; migrated_at: string; }
interface UserHistory { usage: UsageRow[]; subscriptions: SubscriptionRow[]; paymentEvents: PaymentEventRow[]; migrations: MigrationRow[]; userMeta: { is_pro: boolean; plan: string; subscription_status: string | null; pro_since: string | null; drive_email: string | null; created_at: string | null } | null; authUser: AuthUserInfo | null; }

async function af(url: string, token: string, opts?: RequestInit) {
  const res = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts?.headers as Record<string,string> | undefined) } });
  if (!res.ok) {
    const clone = res.clone();
    const body = await clone.text().catch(() => "");
    console.error(`[admin] ${opts?.method ?? "GET"} ${url} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[10px] font-black uppercase tracking-[0.3em] text-[#2A6A2A] mb-3">{children}</h2>;
}
function Th({ children }: { children: React.ReactNode }) { return <th className="px-3 py-2 text-left">{children}</th>; }
function Td({ children }: { children: React.ReactNode }) { return <td className="px-3 py-2 text-[#6B6B6B]">{children}</td>; }
function Notice({ children }: { children: React.ReactNode }) { return <p className="text-xs text-[#00FF88] mb-2">{children}</p>; }
function SmBtn({ children, onClick, disabled, danger }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean; }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`px-2 py-0.5 rounded border text-[10px] font-mono uppercase tracking-widest transition-colors disabled:opacity-40 cursor-pointer ${danger ? "border-[#2A1A1A] text-[#6B6B6B] hover:border-[#EF4444] hover:text-[#EF4444]" : "border-[#1A2A1A] text-[#6B6B6B] hover:border-[#00FF88]/40 hover:text-[#00FF88]"}`}>
      {children}
    </button>
  );
}

// ── Stats Bar ────────────────────────────────────────────────────────────────
function PlatformBreakdown({ stats }: { stats: Stats | null }) {
  if (!stats?.platform_breakdown) return null;
  const entries = Object.entries(stats.platform_breakdown).sort((a, b) => b[1] - a[1]);
  return (
    <section>
      <SectionTitle>Migrations by Platform</SectionTitle>
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded p-4 text-xs font-mono text-[#6B6B6B]">
        {entries.map(([platform, count]) => (
          <div key={platform} className="flex justify-between">
            <span>{platform}</span>
            <span>{count}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TierBreakdown({ stats }: { stats: Stats | null }) {
  if (!stats?.tier_breakdown) return null;
  const entries = Object.entries(stats.tier_breakdown).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return null;
  return (
    <section>
      <SectionTitle>Migrations by Tier (All Time)</SectionTitle>
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded p-4 text-xs font-mono text-[#6B6B6B]">
        {entries.map(([tier, count]) => (
          <div key={tier} className="flex justify-between">
            <span>{tier.replace("tier", "Tier ")}</span>
            <span>{count}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// [ISSUE-32] 3-state Plan badge: free, pro-green (active+autopay), pro-red (expiring soon)
function PlanBadge({ plan, status }: { plan: string; status: string | null }) {
  if (plan !== "pro") {
    return <span className="px-2 py-0.5 rounded text-[10px] font-bold text-[#6B6B6B] bg-[#1A1A1A] border border-[#2A2A2A]">FREE</span>;
  }
  // Pro user — determine if active (green) or expiring soon (red)
  const isActive = status === "active" || status === "authenticated";
  const isCancelled = status === "cancelled";
  if (isActive) {
    return <span className="px-2 py-0.5 rounded text-[10px] font-bold text-[#00FF88] bg-[#00FF88]/10 border border-[#00FF88]/30">PRO</span>;
  }
  if (isCancelled) {
    return <span className="px-2 py-0.5 rounded text-[10px] font-bold text-[#F97316] bg-[#F97316]/10 border border-[#F97316]/30">PRO-RED</span>;
  }
  // Pro plan but no active sub record — likely granted manually
  return <span className="px-2 py-0.5 rounded text-[10px] font-bold text-[#00FF88] bg-[#00FF88]/10 border border-[#00FF88]/30">PRO</span>;
}

function StatsBar({ stats, error }: { stats: Stats | null, error: string | null }) {
  const cards: { label: string; key: keyof Stats }[] = [
    { label: "Total Users", key: "total_users" }, { label: "Pro Users", key: "pro_users" },
    { label: "Total Migrations", key: "total_migrations" }, { label: "Migrations This Month", key: "migrations_this_month" },
  ];
  return (
    <section>
      <SectionTitle>Stats</SectionTitle>
      {error && <p className="text-xs text-[#EF4444] mb-2">{error}</p>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map(({ label, key }) => (
          <div key={key} className="bg-[#0A0A0A] border border-[#1A1A1A] rounded p-4">
            <div className="text-2xl font-bold text-white">{stats ? String(stats[key]) : "—"}</div>
            <div className="text-xs text-[#6B6B6B] font-mono uppercase mt-1">{label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── User History Panel ───────────────────────────────────────────────────────
function UserHistoryPanel({ userId, token }: { userId: string; token: string }) {
  const [history, setHistory] = useState<UserHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true); setError(null);
    af(`/api/admin/user-history?userId=${userId}`, token).then(r => r.json())
      .then((d: UserHistory & { error?: string }) => {
        if (d.error) setError(d.error);
        else setHistory(d);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [userId, token]);

  if (loading) return <div className="px-4 py-3 text-[#3A3A3A] text-center">Loading history…</div>;
  if (error) return <div className="px-4 py-3 text-[#EF4444] text-center">{error}</div>;
  if (!history) return null;

  const now = Date.now();
  const activeSub = history.subscriptions.find(s =>
    (s.status === "active" || s.status === "authenticated") ||
    (s.status === "cancelled" && s.current_period_end && new Date(s.current_period_end).getTime() > now)
  );
  const isExpiringSoon = activeSub?.status === "cancelled" && activeSub.current_period_end;
  const daysLeft = isExpiringSoon ? Math.ceil((new Date(isExpiringSoon).getTime() - now) / 86400000) : null;

  // Summary stats
  const totalAllTime = history.usage.reduce((acc, u) => acc + u.tier1_count + u.tier2_count + u.tier3_count, 0);
  const totalSimple = history.usage.reduce((acc, u) => acc + (u.simple_migrations ?? 0), 0);
  const totalSmart = history.usage.reduce((acc, u) => acc + (u.smart_migrations ?? 0), 0);
  const totalAttention = history.usage.reduce((acc, u) => acc + (u.attention_migrations ?? 0), 0);
  const activeMonths = history.usage.filter(u => u.tier1_count + u.tier2_count + u.tier3_count > 0).length;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const currentMonthData = history.usage.find(u => u.month === currentMonth);

  function fmtDate(d: string | null | undefined): string {
    if (!d) return "—";
    return new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function fmtDateTime(d: string | null | undefined): string {
    if (!d) return "—";
    return new Date(d).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function fmtMoney(amount: number | null, currency: string | null): string {
    if (amount == null) return "—";
    const sym = currency === "INR" ? "₹" : currency === "USD" ? "$" : "";
    return `${sym}${amount.toLocaleString()}`;
  }

  return (
    <div className="px-4 py-3 bg-[#050505] border-t border-[#0F0F0F] space-y-5">
      {/* ── Section 1: Account Info ── */}
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-[#3A3A3A] mb-2">Account Info</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {history.authUser && (
            <>
              <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2">
                <div className="text-[#3A3A3A] text-[10px] uppercase">Email</div>
                <div className="text-[#6B6B6B] text-[10px] font-mono">{history.authUser.email ?? "—"}</div>
              </div>
              <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2">
                <div className="text-[#3A3A3A] text-[10px] uppercase">Auth Provider</div>
                <div className="text-[#6B6B6B] text-[10px] font-mono">{history.authUser.provider ?? "email"}</div>
              </div>
              <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2">
                <div className="text-[#3A3A3A] text-[10px] uppercase">Joined</div>
                <div className="text-[#6B6B6B] text-[10px] font-mono">{fmtDate(history.authUser.created_at)}</div>
              </div>
              <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2">
                <div className="text-[#3A3A3A] text-[10px] uppercase">Last Login</div>
                <div className="text-[#6B6B6B] text-[10px] font-mono">{fmtDateTime(history.authUser.last_sign_in_at)}</div>
              </div>
            </>
          )}
          {history.userMeta && (
            <>
              <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2">
                <div className="text-[#3A3A3A] text-[10px] uppercase">is_pro</div>
                <div className="text-[10px] font-mono" style={{ color: history.userMeta.is_pro ? "#00FF88" : "#6B6B6B" }}>{String(history.userMeta.is_pro)}</div>
              </div>
              <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2">
                <div className="text-[#3A3A3A] text-[10px] uppercase">Plan</div>
                <div className="text-[10px] font-mono">
                  <PlanBadge plan={history.userMeta.plan} status={history.userMeta.subscription_status} />
                </div>
              </div>
              <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2">
                <div className="text-[#3A3A3A] text-[10px] uppercase">Sub Status</div>
                <div className="text-[#6B6B6B] text-[10px] font-mono">{history.userMeta.subscription_status ?? "—"}</div>
              </div>
              <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2">
                <div className="text-[#3A3A3A] text-[10px] uppercase">Pro Since</div>
                <div className="text-[#6B6B6B] text-[10px] font-mono">{fmtDate(history.userMeta.pro_since)}</div>
              </div>
              {history.userMeta.drive_email && (
                <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2">
                  <div className="text-[#3A3A3A] text-[10px] uppercase">Drive Email</div>
                  <div className="text-[#6B6B6B] text-[10px] font-mono">{history.userMeta.drive_email}</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Section 2: Expiring Warning ── */}
      {isExpiringSoon && daysLeft !== null && (
        <div className="text-[10px] font-mono text-[#F97316] border border-[#F97316]/20 rounded px-3 py-2 bg-[#F97316]/5 flex items-center gap-2">
          <span>⚠</span>
          <span>Pro subscription cancelled — expires in {daysLeft} days ({fmtDate(isExpiringSoon)})</span>
        </div>
      )}

      {/* ── Section 3: Summary Stats ── */}
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-[#3A3A3A] mb-2">Summary</div>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2 text-center">
            <div className="text-[#F5F5F5] text-lg font-bold">{totalAllTime}</div>
            <div className="text-[#3A3A3A] text-[10px] uppercase">Total Migrations</div>
          </div>
          <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2 text-center">
            <div className="text-[#F5F5F5] text-lg font-bold">{activeMonths}</div>
            <div className="text-[#3A3A3A] text-[10px] uppercase">Active Months</div>
          </div>
          <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2 text-center">
            <div className="text-[#F5F5F5] text-lg font-bold">{currentMonthData ? currentMonthData.tier1_count + currentMonthData.tier2_count + currentMonthData.tier3_count : 0}</div>
            <div className="text-[#3A3A3A] text-[10px] uppercase">This Month</div>
          </div>
          <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2 text-center">
            <div className="text-[#6B6B6B] text-sm font-bold">{totalSimple}</div>
            <div className="text-[#3A3A3A] text-[10px] uppercase">Simple (legacy)</div>
          </div>
          <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2 text-center">
            <div className="text-[#6B6B6B] text-sm font-bold">{totalSmart}</div>
            <div className="text-[#3A3A3A] text-[10px] uppercase">Smart (legacy)</div>
          </div>
          <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2 text-center">
            <div className="text-[#6B6B6B] text-sm font-bold">{totalAttention}</div>
            <div className="text-[#3A3A3A] text-[10px] uppercase">Attention (legacy)</div>
          </div>
        </div>
      </div>

      {/* ── Section 4: Monthly Usage Table ── */}
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-[#3A3A3A] mb-2">Monthly Usage History</div>
        {history.usage.length === 0 ? (
          <div className="text-[10px] font-mono text-[#3A3A3A] py-2">No usage recorded</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr className="text-[#3A3A3A] uppercase border-b border-[#1A1A1A]">
                  <th className="text-left py-1.5 px-2">Month</th>
                  <th className="text-right py-1.5 px-2">T1</th>
                  <th className="text-right py-1.5 px-2">T2</th>
                  <th className="text-right py-1.5 px-2">T3</th>
                  <th className="text-right py-1.5 px-2 text-[#2A2A2A]">Simple</th>
                  <th className="text-right py-1.5 px-2 text-[#2A2A2A]">Smart</th>
                  <th className="text-right py-1.5 px-2 text-[#2A2A2A]">Attn</th>
                  <th className="text-right py-1.5 px-2 text-[#2A2A2A]">Sessions</th>
                  <th className="text-right py-1.5 px-2 font-bold">Total</th>
                </tr>
              </thead>
              <tbody>
                {history.usage.map((u, i) => {
                  const total = u.tier1_count + u.tier2_count + u.tier3_count;
                  const isCurrent = u.month === currentMonth;
                  return (
                    <tr key={i} className={`border-b border-[#0A0A0A] ${isCurrent ? "bg-[#0F1A0F]" : ""}`}>
                      <td className="px-2 py-1.5 text-[#6B6B6B]">
                        {u.month}
                        {isCurrent && <span className="text-[#00FF88] ml-1">●</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#6B6B6B]">{u.tier1_count}</td>
                      <td className="px-2 py-1.5 text-right text-[#6B6B6B]">{u.tier2_count}</td>
                      <td className="px-2 py-1.5 text-right text-[#6B6B6B]">{u.tier3_count}</td>
                      <td className="px-2 py-1.5 text-right text-[#3A3A3A]">{u.simple_migrations}</td>
                      <td className="px-2 py-1.5 text-right text-[#3A3A3A]">{u.smart_migrations}</td>
                      <td className="px-2 py-1.5 text-right text-[#3A3A3A]">{u.attention_migrations}</td>
                      <td className="px-2 py-1.5 text-right text-[#3A3A3A]">{u.sessions_count}</td>
                      <td className="px-2 py-1.5 text-right text-[#F5F5F5] font-bold">{total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Section 5: Subscription Timeline ── */}
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-[#3A3A3A] mb-2">Subscription Timeline</div>
        {history.subscriptions.length === 0 ? (
          <div className="text-[10px] font-mono text-[#3A3A3A] py-2">No subscription records</div>
        ) : (
          <div className="space-y-2">
            {history.subscriptions.map((s, i) => {
              const sEnd = s.current_period_end;
              const sCancelledActive = s.status === "cancelled" && sEnd && new Date(sEnd).getTime() > now;
              const sExpired = s.status === "cancelled" && sEnd && new Date(sEnd).getTime() <= now;
              const color = s.status === "active" || s.status === "authenticated" ? "#00FF88" : sCancelledActive ? "#F97316" : sExpired ? "#EF4444" : "#6B6B6B";
              return (
                <div key={i} className="bg-[#0A0A0A] border rounded p-3" style={{ borderColor: color + "22" }}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold" style={{ color, backgroundColor: color + "11", border: `1px solid ${color}33` }}>{s.plan.toUpperCase()}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono" style={{ color, backgroundColor: color + "11" }}>{s.status}</span>
                    {s.gateway && <span className="text-[10px] font-mono text-[#3A3A3A]">via {s.gateway}</span>}
                    {s.interval && <span className="text-[10px] font-mono text-[#3A3A3A]">· {s.interval}</span>}
                    {s.amount != null && <span className="text-[10px] font-mono text-[#3A3A3A]">{fmtMoney(s.amount, s.currency)}</span>}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-mono">
                    <div>
                      <span className="text-[#3A3A3A]">Period: </span>
                      <span className="text-[#6B6B6B]">{fmtDate(s.current_period_start)} → {fmtDate(sEnd)}</span>
                    </div>
                    {s.cancelled_at && (
                      <div>
                        <span className="text-[#3A3A3A]">Cancelled: </span>
                        <span className="text-[#EF4444]">{fmtDate(s.cancelled_at)}</span>
                      </div>
                    )}
                    {s.trial_end && (
                      <div>
                        <span className="text-[#3A3A3A]">Trial end: </span>
                        <span className="text-[#6B6B6B]">{fmtDate(s.trial_end)}</span>
                      </div>
                    )}
                    <div>
                      <span className="text-[#3A3A3A]">Updated: </span>
                      <span className="text-[#6B6B6B]">{fmtDate(s.updated_at)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Section 6: Payment Events ── */}
      {history.paymentEvents.length > 0 && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-[#3A3A3A] mb-2">Payment Events ({history.paymentEvents.length})</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr className="text-[#3A3A3A] uppercase border-b border-[#1A1A1A]">
                  <th className="text-left py-1.5 px-2">Date</th>
                  <th className="text-left py-1.5 px-2">Event Type</th>
                  <th className="text-left py-1.5 px-2">Gateway</th>
                  <th className="text-right py-1.5 px-2">Amount</th>
                  <th className="text-left py-1.5 px-2">Gateway Event ID</th>
                </tr>
              </thead>
              <tbody>
                {history.paymentEvents.map((e, i) => (
                  <tr key={i} className="border-b border-[#0A0A0A]">
                    <td className="px-2 py-1.5 text-[#6B6B6B]">{fmtDateTime(e.created_at)}</td>
                    <td className="px-2 py-1.5 text-[#F5F5F5]">{e.event_type}</td>
                    <td className="px-2 py-1.5 text-[#6B6B6B]">{e.gateway ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right text-[#6B6B6B]">{fmtMoney(e.amount, e.currency)}</td>
                    <td className="px-2 py-1.5 text-[#3A3A3A]">{e.gateway_event_id ? e.gateway_event_id.slice(0, 25) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Section 7: Recent Migrations ── */}
      {history.migrations && history.migrations.length > 0 && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-[#3A3A3A] mb-2">Recent Migrations ({history.migrations.length})</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr className="text-[#3A3A3A] uppercase border-b border-[#1A1A1A]">
                  <th className="text-left py-1.5 px-2">Date</th>
                  <th className="text-left py-1.5 px-2">Tier</th>
                  <th className="text-left py-1.5 px-2">From</th>
                  <th className="text-left py-1.5 px-2">To</th>
                  <th className="text-right py-1.5 px-2">Msgs</th>
                  <th className="text-right py-1.5 px-2">Chars</th>
                </tr>
              </thead>
              <tbody>
                {history.migrations.slice(0, 50).map((m, i) => (
                  <tr key={i} className="border-b border-[#0A0A0A]">
                    <td className="px-2 py-1.5 text-[#6B6B6B]">{new Date(m.migrated_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="px-2 py-1.5">
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{
                        color: m.tier === 3 ? "#00FF88" : m.tier === 2 ? "#EAB308" : "#6B6B6B",
                        backgroundColor: (m.tier === 3 ? "#00FF88" : m.tier === 2 ? "#EAB308" : "#6B6B6B") + "11",
                      }}>T{m.tier}</span>
                    </td>
                    <td className="px-2 py-1.5 text-[#6B6B6B]">{m.source_platform ?? "—"}</td>
                    <td className="px-2 py-1.5 text-[#6B6B6B]">{m.target_platform ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right text-[#6B6B6B]">{m.message_count}</td>
                    <td className="px-2 py-1.5 text-right text-[#3A3A3A]">{m.char_count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Users Table ───────────────────────────────────────────────────────────────
function UsersSection({ token, onStatsRefresh }: { token: string; onStatsRefresh?: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [page, setPage]   = useState(1);
  const [total, setTotal] = useState(0);
  const [busy, setBusy]   = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback((p: number) => {
    setBusy(true);
    af(`/api/admin/users?page=${p}`, token).then(r => r.json())
      .then((d: { users: AdminUser[]; total: number; error?: string }) => { if (d.error) setNotice(d.error); else { setUsers(d.users ?? []); setTotal(d.total ?? 0); } })
      .catch((e) => setNotice(String(e)))
      .finally(() => setBusy(false));
  }, [token]);

  useEffect(() => { load(page); }, [page, load]);

  async function action(userId: string, endpoint: string) {
    setNotice(null);
    try {
      const r = await af(`/api/admin/${endpoint}`, token, { method: "POST", body: JSON.stringify({ userId }) });
      const j = await r.json() as { success?: boolean; error?: string };
      if (j.success) {
        setNotice(`✓ ${endpoint} OK`);
        load(page);
        onStatsRefresh?.();
      } else {
        setNotice(`✗ ${endpoint} failed: ${j.error ?? `HTTP ${r.status}`}`);
      }
    } catch (e) {
      setNotice(`✗ ${endpoint} error: ${String(e)}`);
    }
  }

  return (
    <section>
      <SectionTitle>Users</SectionTitle>
      {notice && <Notice>{notice}</Notice>}
      <div className="overflow-x-auto rounded border border-[#1A1A1A]">
        <table className="w-full text-xs font-mono">
          <thead><tr className="border-b border-[#1A1A1A] text-[#3A3A3A] uppercase tracking-widest"><Th>Email</Th><Th>Plan</Th><Th>T1</Th><Th>T2</Th><Th>T3</Th><Th>Joined</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {busy && <tr><td colSpan={7} className="px-3 py-4 text-[#3A3A3A] text-center">Loading…</td></tr>}
            {!busy && users.flatMap(u => {
              const rows = [
                <tr key={u.id} className="border-b border-[#0F0F0F] hover:bg-[#0A0A0A] cursor-pointer" onClick={() => setExpandedId(prev => prev === u.id ? null : u.id)}>
                  <Td>
                    <span className="inline-flex items-center gap-1">
                      <span className="text-[#3A3A3A] select-none">{expandedId === u.id ? "▼" : "▶"}</span>
                      {u.email}
                    </span>
                  </Td>
                  <Td><PlanBadge plan={u.plan} status={u.subscription_status} /></Td>
                  <Td>{u.tier1_used}</Td><Td>{u.tier2_used}</Td><Td>{u.tier3_used}</Td>
                  <Td>{u.created_at ? new Date(u.created_at).toLocaleDateString() : "—"}</Td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}><div className="flex gap-1 flex-wrap">
                    <SmBtn onClick={() => action(u.id, "reset-usage")}>Reset Usage</SmBtn>
                    <SmBtn onClick={() => action(u.id, "grant-pro")}>Grant Pro</SmBtn>
                    <SmBtn danger onClick={() => action(u.id, "revoke-pro")}>Revoke Pro</SmBtn>
                  </div></td>
                </tr>,
              ];
              if (expandedId === u.id) {
                rows.push(
                  <tr key={u.id + "-history"} className="border-b border-[#0F0F0F]">
                    <td colSpan={7} className="p-0">
                      <UserHistoryPanel userId={u.id} token={token} />
                    </td>
                  </tr>
                );
              }
              return rows;
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 mt-2 text-xs text-[#6B6B6B]">
        <SmBtn onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>← Prev</SmBtn>
        <span>Page {page} · {total} users</span>
        <SmBtn onClick={() => setPage(p => p + 1)} disabled={users.length < 20}>Next →</SmBtn>
      </div>
    </section>
  );
}

// ── Usage Controls ────────────────────────────────────────────────────────────
function UsageControlsSection({ token }: { token: string }) {
  const [email, setEmail]   = useState("");
  const [found, setFound]   = useState<FoundUser | null>(null);
  const [err, setErr]       = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy]     = useState(false);

  async function findUser() {
    setErr(null); setFound(null); setNotice(null); setBusy(true);
    try {
      const r = await af(`/api/admin/find-user?email=${encodeURIComponent(email)}`, token);
      const j = await r.json() as FoundUser & { error?: string };
      if (!r.ok) { setErr(j.error ?? `HTTP ${r.status}`); return; }
      setFound(j);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  async function adjust(action: string) {
    if (!found) return;
    setNotice(null);
    try {
      const r = await af("/api/admin/adjust-usage", token, { method: "POST", body: JSON.stringify({ userId: found.id, action }) });
      const j = await r.json() as { success?: boolean; newCounts?: Record<string, number>; error?: string };
      if (j.success && j.newCounts) {
        setFound(f => f ? { ...f, tier1_count: j.newCounts!.tier1_count, tier2_count: j.newCounts!.tier2_count, tier3_count: j.newCounts!.tier3_count } : f);
        setNotice("Updated");
      } else { setNotice(j.error ?? `HTTP ${r.status}`); }
    } catch (e) { setNotice(String(e)); }
  }

  return (
    <section>
      <SectionTitle>Usage Controls</SectionTitle>
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded p-4 space-y-3">
        <div className="flex gap-2">
          <input value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && findUser()}
            placeholder="user@example.com"
            className="flex-1 bg-[#080808] border border-[#2A2A2A] rounded px-3 py-1.5 text-xs font-mono text-[#F5F5F5] placeholder-[#3A3A3A] outline-none focus:border-[#00FF88]/40" />
          <SmBtn onClick={findUser} disabled={busy}>{busy ? "…" : "Find User"}</SmBtn>
        </div>
        {err && <p className="text-xs text-[#EF4444]">{err}</p>}
        {notice && <Notice>{notice}</Notice>}
        {found && (
          <div className="space-y-2">
            <div className="text-xs font-mono text-[#6B6B6B] space-y-0.5">
              <div><span className="text-[#3A3A3A]">Email:</span> {found.email}</div>
              <div><span className="text-[#3A3A3A]">Plan:</span> <span className={found.plan === "pro" ? "text-[#00FF88]" : ""}>{found.plan}</span></div>
              <div><span className="text-[#3A3A3A]">Usage:</span> T1={found.tier1_count} · T2={found.tier2_count} · T3={found.tier3_count}</div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <SmBtn onClick={() => adjust("reset")}>Reset All Counters</SmBtn>
              <SmBtn onClick={() => adjust("add_tier1")}>+10 Credits T1</SmBtn>
              <SmBtn onClick={() => adjust("add_tier2")}>+10 Credits T2</SmBtn>
              <SmBtn onClick={() => adjust("add_tier3")}>+10 Credits T3</SmBtn>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ── Bug Reports ───────────────────────────────────────────────────────────────
const SEV: Record<string, string> = { critical: "#EF4444", high: "#F97316", medium: "#EAB308", low: "#6B6B6B" };

function BugReportsSection({ token }: { token: string }) {
  const [reports, setReports] = useState<BugReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    af("/api/admin/bug-reports", token).then(r => r.json())
      .then((d: { reports: BugReport[]; error?: string }) => { if (d.error) setError(d.error); else setReports(d.reports ?? []); })
      .catch((e) => setError(String(e)));
  }, [token]);
  return (
    <section>
      <SectionTitle>Bug Reports</SectionTitle>
      {error && <p className="text-xs text-[#EF4444] mb-2">{error}</p>}
      <div className="overflow-x-auto rounded border border-[#1A1A1A]">
        <table className="w-full text-xs font-mono">
          <thead><tr className="border-b border-[#1A1A1A] text-[#3A3A3A] uppercase tracking-widest"><Th>Email</Th><Th>Severity</Th><Th>Description</Th><Th>Version</Th><Th>Date</Th></tr></thead>
          <tbody>
            {reports.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-[#3A3A3A] text-center">No reports</td></tr>}
            {reports.map(r => (
              <tr key={r.id} className="border-b border-[#0F0F0F] hover:bg-[#0A0A0A]">
                <Td>{r.email ?? "—"}</Td>
                <td className="px-3 py-2" style={{ color: SEV[r.severity] ?? "#6B6B6B" }}>{r.severity}</td>
                <Td>{r.description.length > 80 ? r.description.slice(0, 80) + "…" : r.description}</Td>
                <Td>{r.version ?? "—"}</Td>
                <Td>{new Date(r.created_at).toLocaleDateString()}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Scraper Bug Reports ──────────────────────────────────────────────────────
interface ScraperBugReport { id: string; platform_id: string; error_message: string | null; href: string | null; user_id: string | null; created_at: string; }

function ScraperBugReportsSection({ token }: { token: string }) {
  const [reports, setReports] = useState<ScraperBugReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    af("/api/scraper-admin/bug-reports", token).then(r => r.json())
      .then((d: ScraperBugReport[] | { error?: string }) => {
        if (Array.isArray(d)) setReports(d); else if (d.error) setError(d.error);
      })
      .catch((e) => setError(String(e)));
  }, [token]);
  return (
    <section>
      <SectionTitle>Scraper Bug Reports</SectionTitle>
      {error && <p className="text-xs text-[#EF4444] mb-2">{error}</p>}
      <div className="overflow-x-auto rounded border border-[#1A1A1A]">
        <table className="w-full text-xs font-mono">
          <thead><tr className="border-b border-[#1A1A1A] text-[#3A3A3A] uppercase tracking-widest"><Th>Platform</Th><Th>Error</Th><Th>URL</Th><Th>Date</Th></tr></thead>
          <tbody>
            {reports.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-[#3A3A3A] text-center">No reports</td></tr>}
            {reports.map(r => (
              <tr key={r.id} className="border-b border-[#0F0F0F] hover:bg-[#0A0A0A]">
                <Td>{r.platform_id}</Td>
                <Td>{r.error_message ? (r.error_message.length > 60 ? r.error_message.slice(0, 60) + "…" : r.error_message) : "—"}</Td>
                <Td>{r.href ? r.href.slice(0, 40) : "—"}</Td>
                <Td>{new Date(r.created_at).toLocaleDateString()}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Refund Requests ───────────────────────────────────────────────────────────
const ST: Record<string, string> = { pending: "#EAB308", approved: "#00FF88", rejected: "#EF4444" };

function RefundsSection({ token }: { token: string }) {
  const [refunds, setRefunds] = useState<RefundRequest[]>([]);
  const [notice, setNotice]   = useState<string | null>(null);

  function load() {
    af("/api/admin/refunds", token).then(r => r.json())
      .then((d: { refunds: RefundRequest[]; error?: string }) => { if (d.error) setNotice(d.error); else setRefunds(d.refunds ?? []); })
      .catch((e) => setNotice(String(e)));
  }
  useEffect(load, [token]);

  async function refundAction(requestId: string, action: "approved" | "rejected") {
    setNotice(null);
    try {
      const r = await af("/api/admin/refund-action", token, { method: "POST", body: JSON.stringify({ requestId, action }) });
      const j = await r.json() as { success?: boolean; error?: string };
      setNotice(j.success ? `Marked ${action}` : (j.error ?? `HTTP ${r.status}`));
    } catch (e) { setNotice(String(e)); }
    load();
  }

  return (
    <section>
      <SectionTitle>Refund Requests</SectionTitle>
      {notice && <Notice>{notice}</Notice>}
      <div className="overflow-x-auto rounded border border-[#1A1A1A]">
        <table className="w-full text-xs font-mono">
          <thead><tr className="border-b border-[#1A1A1A] text-[#3A3A3A] uppercase tracking-widest"><Th>Email</Th><Th>Payment ID</Th><Th>Reason</Th><Th>Status</Th><Th>Date</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {refunds.length === 0 && <tr><td colSpan={6} className="px-3 py-4 text-[#3A3A3A] text-center">No refund requests</td></tr>}
            {refunds.map(r => (
              <tr key={r.id} className="border-b border-[#0F0F0F] hover:bg-[#0A0A0A]">
                <Td>{r.email ?? "—"}</Td>
                <Td>{r.payment_id ?? "—"}</Td>
                <Td>{r.reason.length > 60 ? r.reason.slice(0, 60) + "…" : r.reason}</Td>
                <td className="px-3 py-2" style={{ color: ST[r.status] ?? "#6B6B6B" }}>{r.status}</td>
                <Td>{new Date(r.created_at).toLocaleDateString()}</Td>
                <td className="px-3 py-2"><div className="flex gap-1">
                  <SmBtn onClick={() => refundAction(r.id, "approved")} disabled={r.status !== "pending"}>Approve</SmBtn>
                  <SmBtn danger onClick={() => refundAction(r.id, "rejected")} disabled={r.status !== "pending"}>Reject</SmBtn>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  const refreshStats = useCallback((t: string) => {
    af("/api/admin/stats", t)
      .then(r => r.json())
      .then((d: Stats) => { if (d.total_users !== undefined) setStats(d); else setStatsError("Invalid response"); })
      .catch((e) => setStatsError(String(e)));
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const accessToken = session?.access_token ?? null;
      setToken(accessToken);
      if (accessToken) refreshStats(accessToken);
    });
    // [FIX-ADMIN-STALE-TOKEN] `token` was only ever read once on mount, so once
    // Supabase silently refreshed the underlying session (JWTs expire hourly),
    // every admin API call kept sending the stale token and 403'd — until the
    // page was reloaded and getSession() picked up the refreshed one. Listen
    // for refreshes so `token` stays current without a manual reload.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setToken(session?.access_token ?? null);
    });
    return () => subscription.unsubscribe();
  }, [refreshStats]);

  if (!token) return <div className="p-8 text-[#3A3A3A] text-sm">Loading…</div>;
  return (
    <div className="min-h-screen bg-[#010101] text-[#F5F5F5] p-8 space-y-10">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-black tracking-widest text-[#00FF88]">⚡ Admin Panel</h1>
        <div className="flex gap-3 text-xs font-mono">
          <a href="/admin/scrapers" className="text-[#6B6B6B] hover:text-[#00FF88] transition-colors border border-[#1A2A1A] px-2 py-1 rounded hover:border-[#00FF88]/30">Scrapers →</a>
          <a href="/admin/health" className="text-[#6B6B6B] hover:text-[#00FF88] transition-colors border border-[#1A2A1A] px-2 py-1 rounded hover:border-[#00FF88]/30">DB Health →</a>
        </div>
      </div>
      <StatsBar stats={stats} error={statsError} />
      <PlatformBreakdown stats={stats} />
      <TierBreakdown stats={stats} />
      <UsersSection token={token} onStatsRefresh={() => refreshStats(token)} />
      <UsageControlsSection token={token} />
      <BugReportsSection token={token} />
      <ScraperBugReportsSection token={token} />
      <RefundsSection token={token} />
    </div>
  );
}
