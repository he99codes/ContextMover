"use client";

import { useState, useEffect } from "react";
import {
  Database, Check, Copy, ChevronRight, Loader2, Shield,
  Link2, Terminal, Zap, RefreshCw, Trash2, LogOut,
} from "lucide-react";
import {
  getUserVaultClient, setVaultConfig, clearVaultConfig,
  isVaultConnected, getVaultMeta, syncVaultConfigFromUrl,
  type VaultMeta,
} from "@/lib/user-vault/web-client";
import { cn } from "@/lib/utils";

const SCHEMA_SQL_URL = "https://raw.githubusercontent.com/contextforge/contextforge/main/packages/browser-extension/src/lib/user-vault/schema.sql";

type Screen = "status" | "choose" | "manual-entry" | "manual-testing" | "success" | "delete-confirm";

interface ManualForm {
  url: string;
  anonKey: string;
}

export function VaultSetupWizard() {
  const [screen, setScreen] = useState<Screen>("status");
  const [vaultMeta, setVaultMeta] = useState<VaultMeta | null>(null);
  const [connected, setConnected] = useState(false);
  const [form, setForm] = useState<ManualForm>({ url: "", anonKey: "" });
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [sessionsCount, setSessionsCount] = useState<number | null>(null);
  const [deleteInput, setDeleteInput] = useState("");

  useEffect(() => {
    syncVaultConfigFromUrl();
    const c = isVaultConnected();
    setConnected(c);
    if (c) {
      setVaultMeta(getVaultMeta());
      setScreen("status");
      loadSessionsCount();
    }
  }, []);

  async function loadSessionsCount() {
    const client = getUserVaultClient();
    if (!client) return;
    const { count } = await client.from("cf_sessions").select("id", { count: "exact", head: true });
    setSessionsCount(count ?? 0);
  }

  async function handleManualConnect() {
    setError(null);
    setTesting(true);
    setScreen("manual-testing");
    try {
      const url = form.url.trim().replace(/\/$/, "");
      const anonKey = form.anonKey.trim();

      if (!url.match(/^https:\/\/[a-z0-9]+\.supabase\.co$/)) {
        throw new Error("Invalid URL format. Expected: https://xxxx.supabase.co");
      }
      if (!anonKey) throw new Error("Anon key is required");

      // Test connection and check schema.
      const { createBrowserClient } = await import("@supabase/ssr");
      const client = createBrowserClient(url, anonKey);
      const { error: pingErr } = await client.from("cf_sessions").select("id").limit(1);

      if (pingErr?.code === "42P01") {
        throw new Error(
          "Vault schema not found. Please run the Setup SQL in your Supabase Dashboard → SQL Editor, then try again."
        );
      } else if (pingErr && !pingErr.message?.includes("Results contain 0 rows")) {
        throw new Error(`Connection failed: ${pingErr.message}`);
      }

      setVaultConfig(url, anonKey, { connectionMethod: "manual", connectedAt: Date.now() });
      setVaultMeta(getVaultMeta());
      setConnected(true);
      setScreen("success");
      await loadSessionsCount();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScreen("manual-entry");
    } finally {
      setTesting(false);
    }
  }

  async function handleDisconnect() {
    clearVaultConfig();
    setConnected(false);
    setVaultMeta(null);
    setSessionsCount(null);
    setScreen("choose");
  }

  async function handleDeleteData() {
    const client = getUserVaultClient();
    if (!client) return;
    setTesting(true);
    try {
      const tables = ["cf_edges", "cf_nodes", "cf_migrations", "cf_ide_snapshots", "cf_github_repos", "cf_prompt_templates", "cf_sessions"];
      for (const t of tables) {
        try { await client.from(t).delete().neq("id", "\x00"); } catch { /* ignore */ }
      }
      setSessionsCount(0);
      setScreen("status");
      setDeleteInput("");
    } finally {
      setTesting(false);
    }
  }

  function copyText(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  const schemaSql = `-- Run this in your Supabase Dashboard → SQL Editor
create extension if not exists "uuid-ossp";
create table if not exists cf_sessions (
  id text primary key, platform text not null, title text,
  messages jsonb not null default '[]', message_count integer default 0,
  user_message_count integer default 0, assistant_message_count integer default 0,
  captured_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists cf_migrations (
  id uuid primary key default uuid_generate_v4(),
  session_id text references cf_sessions(id),
  source_platform text, target_platform text, tier integer,
  compression_ratio float, migrated_at timestamptz default now()
);
create table if not exists cf_nodes (
  id text primary key, type text not null, label text not null, content text,
  metadata jsonb default '{}', importance float default 0.5, source text not null,
  session_id text references cf_sessions(id), created_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists cf_edges (
  id text primary key,
  source_id text references cf_nodes(id) on delete cascade,
  target_id text references cf_nodes(id) on delete cascade,
  type text not null, weight float default 0.5,
  created_at timestamptz default now()
);
create index if not exists cf_sessions_updated_idx on cf_sessions(updated_at desc);
alter publication supabase_realtime add table cf_sessions;`;

  if (screen === "status" && connected) {
    return (
      <div className="max-w-2xl mx-auto space-y-5">
        {/* Connected banner */}
        <div className="flex items-center gap-3 rounded-[8px] border border-[#00FF88]/20 bg-[#00FF88]/6 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-[6px] bg-[#00FF88]/12 border border-[#00FF88]/25">
            <Check size={16} className="text-[#00FF88]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[#F5F5F5]">
              {vaultMeta?.projectName ?? "Personal Vault"} connected
            </p>
            <p className="text-xs text-[#6B6B6B]">{vaultMeta?.projectUrl}</p>
          </div>
          <span className="text-[10px] font-mono uppercase tracking-widest px-2 py-1 rounded-[4px] border border-[#00FF88]/20 text-[#00FF88]">
            {vaultMeta?.connectionMethod ?? "manual"}
          </span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Sessions", value: sessionsCount !== null ? String(sessionsCount) : "–" },
            { label: "Region", value: vaultMeta?.region ?? "—" },
            { label: "Method", value: vaultMeta?.connectionMethod ?? "—" },
          ].map((s) => (
            <div key={s.label} className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-4 text-center">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[#6B6B6B]">{s.label}</p>
              <p className="mt-1 text-lg font-black text-[#F5F5F5] tabular-nums">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Privacy notice */}
        <div className="flex items-start gap-3 rounded-[6px] border border-[#00FF88]/10 bg-[#00FF88]/4 px-4 py-3">
          <Shield size={13} className="mt-0.5 shrink-0 text-[#00FF88]" />
          <p className="text-[11px] text-[#4A8A4A] leading-relaxed">
            Your conversations are stored exclusively in your Supabase project. ContextForge servers have zero access to this data. You own it completely.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => { void loadSessionsCount(); }}
            className="inline-flex items-center gap-1.5 rounded-[4px] border border-[#2A2A2A] px-3 py-2 text-xs font-medium text-[#6B6B6B] hover:text-[#F5F5F5] hover:border-[#3A3A3A] transition-colors"
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <a
            href={`https://app.supabase.com/project/${vaultMeta?.projectRef ?? "_"}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-[4px] border border-[#2A2A2A] px-3 py-2 text-xs font-medium text-[#6B6B6B] hover:text-[#F5F5F5] hover:border-[#3A3A3A] transition-colors"
          >
            <Database size={12} /> Open Supabase Dashboard
          </a>
          <button
            onClick={() => setScreen("delete-confirm")}
            className="inline-flex items-center gap-1.5 rounded-[4px] border border-red-500/25 px-3 py-2 text-xs font-medium text-red-400 hover:border-red-500/40 hover:bg-red-500/5 transition-colors"
          >
            <Trash2 size={12} /> Delete vault data
          </button>
          <button
            onClick={handleDisconnect}
            className="inline-flex items-center gap-1.5 rounded-[4px] border border-[#2A2A2A] px-3 py-2 text-xs font-medium text-[#6B6B6B] hover:text-[#F5F5F5] hover:border-[#3A3A3A] transition-colors"
          >
            <LogOut size={12} /> Disconnect
          </button>
        </div>
      </div>
    );
  }

  if (screen === "delete-confirm") {
    return (
      <div className="max-w-md mx-auto space-y-5">
        <div className="rounded-[8px] border border-red-500/30 bg-red-500/5 p-6">
          <Trash2 size={20} className="mb-3 text-red-400" />
          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-2">Delete all vault data?</h3>
          <p className="text-xs text-[#6B6B6B] mb-4">
            This permanently deletes all sessions, memory nodes, and edges from your Supabase vault. Your local extension data is NOT affected.
          </p>
          <p className="text-xs text-[#6B6B6B] mb-2">Type <strong className="text-[#F5F5F5]">delete</strong> to confirm:</p>
          <input
            value={deleteInput}
            onChange={(e) => setDeleteInput(e.target.value)}
            className="w-full rounded-[4px] border border-[#3A3A3A] bg-[#111] px-3 py-2 text-sm font-mono text-[#F5F5F5] outline-none focus:border-red-500/50 mb-4"
            placeholder="delete"
          />
          <div className="flex gap-2">
            <button
              onClick={() => { setDeleteInput(""); setScreen("status"); }}
              className="flex-1 rounded-[4px] border border-[#2A2A2A] px-3 py-2 text-xs font-medium text-[#6B6B6B] hover:bg-[#1A1A1A] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleDeleteData()}
              disabled={deleteInput !== "delete" || testing}
              className="flex-1 rounded-[4px] bg-red-600/80 px-3 py-2 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5"
            >
              {testing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Delete all data
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "manual-testing") {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Loader2 size={22} className="mb-4 animate-spin text-[#00FF88]" />
        <p className="text-sm font-medium text-[#F5F5F5]">Testing connection…</p>
        <p className="mt-1 text-xs text-[#6B6B6B]">Connecting to your Supabase project</p>
      </div>
    );
  }

  if (screen === "success") {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center max-w-md mx-auto">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-[#00FF88]/10 border border-[#00FF88]/25" style={{ boxShadow: "0 0 30px rgba(0,255,136,0.15)" }}>
          <Check size={28} className="text-[#00FF88]" />
        </div>
        <h2 className="text-lg font-black uppercase tracking-widest text-[#F5F5F5]">Vault connected!</h2>
        <p className="mt-2 text-xs font-mono text-[#2A6A2A] max-w-xs">
          Your sessions now sync to your personal Supabase. ContextForge never sees this data.
        </p>
        <button
          onClick={() => setScreen("status")}
          className="mt-6 inline-flex items-center gap-2 rounded-[6px] border border-[#00FF88]/30 bg-[#00FF88]/8 px-5 py-2.5 text-xs font-black uppercase tracking-widest text-[#00FF88] transition-all hover:bg-[#00FF88]/12"
        >
          View vault status →
        </button>
      </div>
    );
  }

  if (screen === "manual-entry") {
    return (
      <div className="max-w-lg mx-auto space-y-5">
        <button onClick={() => setScreen("choose")} className="text-xs text-[#6B6B6B] hover:text-[#F5F5F5] flex items-center gap-1 transition-colors">
          ← Back
        </button>

        <div>
          <h2 className="text-lg font-semibold text-[#F5F5F5]">Connect manually</h2>
          <p className="mt-1 text-sm text-[#6B6B6B]">Enter your Supabase project URL and anon key.</p>
        </div>

        {error && (
          <div className="rounded-[6px] border border-red-500/30 bg-red-500/8 px-4 py-3 text-xs text-red-400">{error}</div>
        )}

        {/* Schema setup instructions */}
        <div className="rounded-[8px] border border-[#2A2A2A] bg-[#111] p-4 space-y-3">
          <p className="text-xs font-semibold text-[#F5F5F5] flex items-center gap-2">
            <Terminal size={13} className="text-[#6B6B6B]" /> Step 1: Deploy vault schema
          </p>
          <p className="text-xs text-[#6B6B6B]">
            Open your <a href="https://app.supabase.com" target="_blank" rel="noopener noreferrer" className="text-[#00FF88] hover:underline">Supabase Dashboard</a> → SQL Editor and run this SQL:
          </p>
          <div className="relative rounded-[4px] border border-[#2A2A2A] bg-[#0A0A0A] p-3">
            <pre className="text-[9px] font-mono text-[#4A4A4A] overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-40">{schemaSql}</pre>
            <button
              onClick={() => copyText(schemaSql, "sql")}
              className="absolute top-2 right-2 flex items-center gap-1 rounded-[3px] border border-[#2A2A2A] bg-[#111] px-2 py-1 text-[9px] font-medium text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors"
            >
              {copied === "sql" ? <Check size={9} className="text-[#00FF88]" /> : <Copy size={9} />}
              {copied === "sql" ? "Copied!" : "Copy SQL"}
            </button>
          </div>
        </div>

        {/* Form */}
        <div className="rounded-[8px] border border-[#2A2A2A] bg-[#111] p-4 space-y-3">
          <p className="text-xs font-semibold text-[#F5F5F5] flex items-center gap-2">
            <Link2 size={13} className="text-[#6B6B6B]" /> Step 2: Enter connection details
          </p>
          <div className="space-y-3">
            <div>
              <label className="block text-[10px] font-medium uppercase tracking-widest text-[#6B6B6B] mb-1.5">Project URL</label>
              <input
                type="url"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder="https://xxxx.supabase.co"
                className="w-full rounded-[4px] border border-[#2A2A2A] bg-[#0A0A0A] px-3 py-2 text-sm font-mono text-[#F5F5F5] outline-none focus:border-[#00FF88]/40 transition-colors placeholder:text-[#2A2A2A]"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium uppercase tracking-widest text-[#6B6B6B] mb-1.5">Anon (public) key</label>
              <input
                type="text"
                value={form.anonKey}
                onChange={(e) => setForm((f) => ({ ...f, anonKey: e.target.value }))}
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
                className="w-full rounded-[4px] border border-[#2A2A2A] bg-[#0A0A0A] px-3 py-2 text-sm font-mono text-[#F5F5F5] outline-none focus:border-[#00FF88]/40 transition-colors placeholder:text-[#2A2A2A]"
              />
              <p className="mt-1 text-[10px] text-[#3A3A3A]">Found in your Supabase project → Settings → API</p>
            </div>
          </div>
          <button
            onClick={() => void handleManualConnect()}
            disabled={!form.url || !form.anonKey || testing}
            className={cn(
              "w-full rounded-[6px] py-2.5 text-sm font-semibold transition-all",
              form.url && form.anonKey
                ? "bg-[#00FF88] text-black hover:bg-[#00FF88]/90"
                : "bg-[#1A1A1A] text-[#3A3A3A] cursor-not-allowed"
            )}
          >
            {testing ? <span className="flex items-center justify-center gap-2"><Loader2 size={14} className="animate-spin" /> Testing…</span> : "Connect vault"}
          </button>
        </div>
      </div>
    );
  }

  // choose screen (default for not-connected)
  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Shield size={16} className="text-[#00FF88]" />
          <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#00FF88]">Zero-knowledge privacy</span>
        </div>
        <h2 className="text-xl font-black text-[#F5F5F5]">Connect your Personal Vault</h2>
        <p className="mt-2 text-sm text-[#6B6B6B] leading-relaxed">
          Your conversation data is stored ONLY in your browser extension's local storage. Connect your own Supabase project to enable cross-device sync and Super Memory — ContextForge never sees it.
        </p>
      </div>

      <div className="space-y-3">
        <button
          onClick={() => setScreen("manual-entry")}
          className="group w-full flex items-center gap-4 rounded-[8px] border border-[#2A2A2A] bg-[#111] p-5 text-left transition-all hover:border-[#00FF88]/25 hover:bg-[#00FF88]/4"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] border border-[#2A2A2A] bg-[#0A0A0A] group-hover:border-[#00FF88]/25 transition-colors">
            <Terminal size={16} className="text-[#6B6B6B] group-hover:text-[#00FF88]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[#F5F5F5]">Manual setup</p>
            <p className="text-xs text-[#6B6B6B] mt-0.5">Paste your Supabase URL + anon key. Takes 2 minutes.</p>
          </div>
          <ChevronRight size={16} className="text-[#3A3A3A] group-hover:text-[#00FF88] transition-colors" />
        </button>

        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-[#1A1A1A]" />
          <span className="text-[10px] font-mono text-[#2A2A2A] uppercase tracking-widest">or</span>
          <div className="flex-1 h-px bg-[#1A1A1A]" />
        </div>

        <div className="group w-full flex items-center gap-4 rounded-[8px] border border-[#1A1A1A] bg-[#0A0A0A] p-5 text-left opacity-60 cursor-not-allowed">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] border border-[#1A1A1A] bg-[#060606]">
            <Zap size={16} className="text-[#2A2A2A]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[#3A3A3A]">One-click OAuth <span className="ml-2 text-[9px] uppercase tracking-widest border border-[#2A2A2A] text-[#2A2A2A] px-1.5 py-0.5 rounded-[3px]">Coming soon</span></p>
            <p className="text-xs text-[#2A2A2A] mt-0.5">Auto-create a Supabase project, deploy schema. ~45 seconds.</p>
          </div>
        </div>
      </div>

      {/* Trust signals */}
      <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-[#2A4A2A]">
        {[
          "Your Supabase, your rules",
          "AES-256-GCM encrypted config",
          "ContextForge has zero access",
          "Disconnect without data loss",
        ].map((t) => (
          <div key={t} className="flex items-center gap-1.5">
            <Check size={10} className="text-[#00FF88] shrink-0" />
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}
