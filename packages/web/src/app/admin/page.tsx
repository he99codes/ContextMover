"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Stats { total_users: number; pro_users: number; migrations_this_month: number; open_bug_reports: number; }
interface AdminUser { id: string; email: string; created_at: string; plan: string; subscription_status: string | null; tier1_used: number; tier2_used: number; tier3_used: number; }
interface BugReport { id: string; email: string | null; severity: string; description: string; version: string | null; created_at: string; }
interface RefundRequest { id: string; email: string | null; payment_id: string | null; reason: string; status: string; created_at: string; }
interface FoundUser { id: string; email: string; created_at: string; plan: string; status: string | null; tier1_count: number; tier2_count: number; tier3_count: number; }

async function af(url: string, token: string, opts?: RequestInit) {
  return fetch(url, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts?.headers as Record<string,string> | undefined) } });
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
function StatsBar({ token }: { token: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => { af("/api/admin/stats", token).then(r => r.json()).then((d: Stats) => setStats(d)).catch(() => {}); }, [token]);
  const cards: { label: string; key: keyof Stats }[] = [
    { label: "Total Users", key: "total_users" }, { label: "Pro Users", key: "pro_users" },
    { label: "Migrations This Month", key: "migrations_this_month" }, { label: "Bug Reports Open", key: "open_bug_reports" },
  ];
  return (
    <section>
      <SectionTitle>Stats</SectionTitle>
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

// ── Users Table ───────────────────────────────────────────────────────────────
function UsersSection({ token }: { token: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [page, setPage]   = useState(1);
  const [total, setTotal] = useState(0);
  const [busy, setBusy]   = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((p: number) => {
    setBusy(true);
    af(`/api/admin/users?page=${p}`, token).then(r => r.json())
      .then((d: { users: AdminUser[]; total: number }) => { setUsers(d.users ?? []); setTotal(d.total ?? 0); })
      .finally(() => setBusy(false));
  }, [token]);

  useEffect(() => { load(page); }, [page, load]);

  async function action(userId: string, endpoint: string) {
    setNotice(null);
    const r = await af(`/api/admin/${endpoint}`, token, { method: "POST", body: JSON.stringify({ userId }) });
    const j = await r.json() as { success?: boolean; error?: string };
    setNotice(j.success ? `${endpoint} OK` : (j.error ?? "Error"));
    load(page);
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
            {!busy && users.map(u => (
              <tr key={u.id} className="border-b border-[#0F0F0F] hover:bg-[#0A0A0A]">
                <Td>{u.email}</Td>
                <Td><span className={u.plan === "pro" ? "text-[#00FF88]" : "text-[#6B6B6B]"}>{u.plan}</span></Td>
                <Td>{u.tier1_used}</Td><Td>{u.tier2_used}</Td><Td>{u.tier3_used}</Td>
                <Td>{u.created_at ? new Date(u.created_at).toLocaleDateString() : "—"}</Td>
                <td className="px-3 py-2"><div className="flex gap-1 flex-wrap">
                  <SmBtn onClick={() => action(u.id, "reset-usage")}>Reset Usage</SmBtn>
                  <SmBtn onClick={() => action(u.id, "grant-pro")}>Grant Pro</SmBtn>
                  <SmBtn danger onClick={() => action(u.id, "revoke-pro")}>Revoke Pro</SmBtn>
                </div></td>
              </tr>
            ))}
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
      if (!r.ok) { const j = await r.json() as { error?: string }; setErr(j.error ?? "Not found"); return; }
      setFound(await r.json() as FoundUser);
    } finally { setBusy(false); }
  }

  async function adjust(action: string) {
    if (!found) return;
    setNotice(null);
    const r = await af("/api/admin/adjust-usage", token, { method: "POST", body: JSON.stringify({ userId: found.id, action }) });
    const j = await r.json() as { success?: boolean; newCounts?: Record<string, number>; error?: string };
    if (j.success && j.newCounts) {
      setFound(f => f ? { ...f, tier1_count: j.newCounts!.tier1_count, tier2_count: j.newCounts!.tier2_count, tier3_count: j.newCounts!.tier3_count } : f);
      setNotice("Updated");
    } else { setNotice(j.error ?? "Error"); }
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
  useEffect(() => {
    af("/api/admin/bug-reports", token).then(r => r.json()).then((d: { reports: BugReport[] }) => setReports(d.reports ?? [])).catch(() => {});
  }, [token]);
  return (
    <section>
      <SectionTitle>Bug Reports</SectionTitle>
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

// ── Refund Requests ───────────────────────────────────────────────────────────
const ST: Record<string, string> = { pending: "#EAB308", approved: "#00FF88", rejected: "#EF4444" };

function RefundsSection({ token }: { token: string }) {
  const [refunds, setRefunds] = useState<RefundRequest[]>([]);
  const [notice, setNotice]   = useState<string | null>(null);

  function load() {
    af("/api/admin/refunds", token).then(r => r.json()).then((d: { refunds: RefundRequest[] }) => setRefunds(d.refunds ?? [])).catch(() => {});
  }
  useEffect(load, [token]);

  async function refundAction(requestId: string, action: "approved" | "rejected") {
    setNotice(null);
    const r = await af("/api/admin/refund-action", token, { method: "POST", body: JSON.stringify({ requestId, action }) });
    const j = await r.json() as { success?: boolean; error?: string };
    setNotice(j.success ? `Marked ${action}` : (j.error ?? "Error"));
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
  const supabase = createClient();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setToken(session?.access_token ?? null));
  }, []);
  if (!token) return <div className="p-8 text-[#3A3A3A] text-sm">Loading…</div>;
  return (
    <div className="min-h-screen bg-[#010101] text-[#F5F5F5] p-8 space-y-10">
      <h1 className="text-lg font-black tracking-widest text-[#00FF88]">⚡ Admin Panel</h1>
      <StatsBar token={token} />
      <UsersSection token={token} />
      <UsageControlsSection token={token} />
      <BugReportsSection token={token} />
      <RefundsSection token={token} />
    </div>
  );
}
