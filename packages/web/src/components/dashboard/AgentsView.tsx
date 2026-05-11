"use client";

import { useState, useEffect, useCallback } from "react";
import { Bot, Plus, Pencil, Trash2, Loader2, Check, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { CustomAgent } from "@/types";

type AgentDraft = {
  name: string;
  url: string;
  input_selector: string;
  message_selector: string;
  role_detection: string;
  output_format: "xml" | "markdown" | "plain";
};

const EMPTY_DRAFT: AgentDraft = {
  name: "",
  url: "",
  input_selector: "",
  message_selector: "",
  role_detection: "",
  output_format: "markdown",
};

interface Props {
  initialAgents: CustomAgent[];
  userId: string;
}

export function AgentsView({ initialAgents, userId }: Props) {
  const [agents, setAgents] = useState<CustomAgent[]>(initialAgents);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("custom_agents")
      .select("*")
      .order("created_at", { ascending: false });
    setAgents((data ?? []) as CustomAgent[]);
  }, []);

  // Realtime subscription
  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();
    const ch = supabase
      .channel("agents-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "custom_agents", filter: `user_id=eq.${userId}` },
        () => { void refresh(); }
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [userId, refresh]);

  function startCreate() {
    setDraft(EMPTY_DRAFT);
    setError(null);
    setEditingId(null);
    setIsCreating(true);
  }

  function startEdit(agent: CustomAgent) {
    setDraft({
      name: agent.name,
      url: agent.url,
      input_selector: agent.input_selector ?? "",
      message_selector: agent.message_selector ?? "",
      role_detection: agent.role_detection ?? "",
      output_format: (agent.output_format as AgentDraft["output_format"]) ?? "markdown",
    });
    setError(null);
    setIsCreating(false);
    setEditingId(agent.id);
  }

  function cancel() {
    setIsCreating(false);
    setEditingId(null);
    setError(null);
  }

  async function save() {
    if (!draft.name.trim() || !draft.url.trim()) {
      setError("Name and URL are required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      if (editingId) {
        const { error: err } = await supabase
          .from("custom_agents")
          .update(draft as never)
          .eq("id", editingId);
        if (err) throw new Error(err.message);
      } else {
        const { error: err } = await supabase
          .from("custom_agents")
          .insert({ ...draft, user_id: userId } as never);
        if (err) throw new Error(err.message);
      }
      cancel();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this custom agent?")) return;
    const supabase = createClient();
    await supabase.from("custom_agents").delete().eq("id", id);
    await refresh();
  }

  const isFormOpen = isCreating || editingId !== null;

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[#F5F5F5]">Agents</h1>
          <p className="mt-1 text-sm text-[#6B6B6B]">
            Configure custom AI platforms beyond the built-in Claude / ChatGPT / Gemini / Grok.
          </p>
        </div>
        {!isFormOpen && (
          <button
            onClick={startCreate}
            className="inline-flex h-9 px-3.5 items-center gap-1.5 rounded-[4px] bg-[#00FF88] text-black text-sm font-semibold hover:bg-[#00CC6A] transition-all hover:shadow-[0_0_12px_rgba(0,255,136,0.25)]"
          >
            <Plus size={14} /> New agent
          </button>
        )}
      </div>

      {isFormOpen && (
        <div className="rounded-[8px] border border-[#00FF88]/20 bg-[#111111] p-5 mb-6">
          <h2 className="text-sm font-semibold text-[#F5F5F5] mb-4">
            {editingId ? "Edit agent" : "New custom agent"}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Display name *" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="My Coding Assistant" />
            <Field label="URL pattern *" value={draft.url} onChange={(v) => setDraft({ ...draft, url: v })} placeholder="https://example.com/*" />
            <Field label="Input selector" value={draft.input_selector} onChange={(v) => setDraft({ ...draft, input_selector: v })} placeholder="textarea[data-input]" />
            <Field label="Message selector" value={draft.message_selector} onChange={(v) => setDraft({ ...draft, message_selector: v })} placeholder="[data-message]" />
            <Field label="Role detection" value={draft.role_detection} onChange={(v) => setDraft({ ...draft, role_detection: v })} placeholder="data-role" />

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[#6B6B6B] uppercase tracking-wider">Output format</label>
              <select
                value={draft.output_format}
                onChange={(e) => setDraft({ ...draft, output_format: e.target.value as AgentDraft["output_format"] })}
                className="h-9 px-2.5 rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] text-sm text-[#F5F5F5] outline-none focus:border-[#00FF88]"
              >
                <option value="markdown">Markdown</option>
                <option value="xml">XML</option>
                <option value="plain">Plain text</option>
              </select>
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              onClick={cancel}
              disabled={busy}
              className="inline-flex h-9 px-3 items-center gap-1.5 rounded-[4px] border border-[#2A2A2A] text-sm font-medium text-[#F5F5F5] hover:bg-[#2A2A2A] disabled:opacity-50 transition-colors"
            >
              <X size={13} /> Cancel
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="inline-flex h-9 px-3.5 items-center gap-1.5 rounded-[4px] bg-[#00FF88] text-black text-sm font-semibold hover:bg-[#00CC6A] disabled:opacity-50 transition-all"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              {editingId ? "Save changes" : "Create agent"}
            </button>
          </div>
        </div>
      )}

      {agents.length === 0 ? (
        <div className="flex flex-col items-center rounded-[8px] border border-dashed border-[#2A2A2A] bg-[#111111] py-16 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] bg-[#00FF88]/10 border border-[#00FF88]/20">
            <Bot size={20} className="text-[#00FF88]" />
          </div>
          <h3 className="text-sm font-medium text-[#F5F5F5]">No custom agents yet</h3>
          <p className="mt-1.5 max-w-sm text-sm text-[#6B6B6B]">
            Add a custom agent to capture context from any other AI chat site.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {agents.map((a) => (
            <div
              key={a.id}
              className={cn(
                "group rounded-[8px] border p-4 flex items-start gap-4 transition-all",
                editingId === a.id
                  ? "bg-[#1A1A1A] border-[#00FF88]/25"
                  : "bg-[#1A1A1A] border-[#2A2A2A] hover:border-[#00FF88]/20 hover:shadow-[0_0_12px_rgba(0,255,136,0.05)]"
              )}
            >
              <div className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-[4px] bg-[#00FF88]/10 border border-[#00FF88]/20 shrink-0">
                <Bot size={15} className="text-[#00FF88]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[#F5F5F5]">{a.name}</p>
                <p className="text-xs text-[#6B6B6B] mt-0.5 truncate">{a.url}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#6B6B6B]">
                  {a.input_selector && <span><strong className="text-[#F5F5F5]/70">input:</strong> <code className="text-[#00FF88]/70">{a.input_selector}</code></span>}
                  {a.message_selector && <span><strong className="text-[#F5F5F5]/70">msg:</strong> <code className="text-[#00FF88]/70">{a.message_selector}</code></span>}
                  {a.output_format && <span className="uppercase">{a.output_format}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => startEdit(a)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-[#6B6B6B] hover:bg-[#2A2A2A] hover:text-[#F5F5F5]"
                  title="Edit"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => remove(a.id)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-[#6B6B6B] hover:bg-red-500/10 hover:text-red-400"
                  title="Delete"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({
  label, value, onChange, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-[#6B6B6B] uppercase tracking-wider">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 px-2.5 rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] text-sm font-mono text-[#F5F5F5] placeholder:text-[#6B6B6B] outline-none focus:border-[#00FF88]"
      />
    </div>
  );
}
