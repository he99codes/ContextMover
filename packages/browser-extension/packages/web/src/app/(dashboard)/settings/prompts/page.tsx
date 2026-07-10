"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatDistanceToNow } from "date-fns";

// ─────────────────────────────────────────────────────────────────────────────
// Types (local — no extension import in web package)
// ─────────────────────────────────────────────────────────────────────────────

type TargetPlatform = "claude" | "chatgpt" | "gemini" | "grok" | "all";

interface PromptTemplate {
  id: string;
  userId: string;
  name: string;
  description: string;
  content: string;
  icon: string;
  tags: string[];
  targetPlatforms: TargetPlatform[];
  isDefault: boolean;
  isSystem: boolean;
  usageCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface PromptAssignment {
  id: string;
  userId: string;
  templateId: string;
  sessionId?: string;
  platform?: string;
  createdAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ICON_OPTIONS = ["🏗️", "🔍", "🔬", "🏛️", "🎓", "⚡", "🧠", "⚙️", "🛡️", "🚀", "🧪", "📝", "♻️", "🔌", "🗄️"];
const PLATFORM_OPTIONS: { value: TargetPlatform; label: string }[] = [
  { value: "all", label: "All platforms" },
  { value: "claude", label: "Claude" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "gemini", label: "Google Gemini" },
  { value: "grok", label: "xAI Grok" },
];

const SYSTEM_TEMPLATE_STUBS: PromptTemplate[] = [
  { id: "system-senior-engineer",  name: "Senior Engineer",       icon: "🏗️", description: "Production-ready code with best practices",          content: "", tags: ["engineering"], targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-debug-mode",       name: "Debug Mode",            icon: "🔍", description: "Root cause analysis and precise fixes",               content: "", tags: ["debugging"],  targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-code-reviewer",    name: "Code Reviewer",         icon: "🔬", description: "Critical code review with severity ratings",          content: "", tags: ["review"],     targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-architecture",     name: "Architecture Mode",     icon: "🏛️", description: "System design and architectural decisions",           content: "", tags: ["architecture"], targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-teaching",         name: "Teaching Mode",         icon: "🎓", description: "Learn deeply with clear explanations",                content: "", tags: ["learning"],   targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-speed",            name: "Speed Mode",            icon: "⚡", description: "Maximum conciseness, minimum words",                  content: "", tags: ["fast"],       targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-security-auditor", name: "Security Auditor",      icon: "🛡️", description: "Deep security analysis and hardening",               content: "", tags: ["security"],   targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-performance",      name: "Performance Optimizer", icon: "🚀", description: "Profile, identify and fix bottlenecks",               content: "", tags: ["performance"], targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-test-writer",      name: "Test Writer",           icon: "🧪", description: "TDD-focused comprehensive test coverage",             content: "", tags: ["testing"],    targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-documentation",    name: "Documentation Writer",  icon: "📝", description: "Clear, developer-friendly documentation",             content: "", tags: ["docs"],       targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-refactoring",      name: "Refactoring Expert",    icon: "♻️", description: "Clean up technical debt without breaking things",     content: "", tags: ["refactoring"], targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-api-designer",     name: "API Designer",          icon: "🔌", description: "RESTful and GraphQL API design expert",               content: "", tags: ["API"],         targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-database",         name: "Database Optimizer",    icon: "🗄️", description: "Query optimization and schema design",               content: "", tags: ["database"],   targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-devops",           name: "DevOps Engineer",       icon: "⚙️", description: "CI/CD, Docker, infrastructure and deployment",       content: "", tags: ["DevOps"],     targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
  { id: "system-open-source",      name: "Open Source Contributor", icon: "🌐", description: "Contribution-ready code for public projects",      content: "", tags: ["open source"], targetPlatforms: ["all"], isDefault: false, isSystem: true, usageCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0, userId: "system" },
];

const EMPTY_FORM: Omit<PromptTemplate, "id" | "userId" | "isSystem" | "usageCount" | "lastUsedAt" | "createdAt" | "updatedAt"> = {
  name: "", description: "", content: "", icon: "⚙️",
  tags: [], targetPlatforms: ["all"], isDefault: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function PromptsPage() {
  const supabase = createClient();

  const [userTemplates, setUserTemplates] = useState<PromptTemplate[]>([]);
  const [assignments, setAssignments] = useState<PromptAssignment[]>([]);
  const [selected, setSelected] = useState<PromptTemplate | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  // ── Load data ───────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

    const [{ data: templates }, { data: assigns }] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any).from("prompt_templates").select("*").eq("user_id", user.id).order("updated_at", { ascending: false }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any).from("prompt_assignments").select("*").eq("user_id", user.id),
    ]) as [{ data: Record<string, unknown>[] | null }, { data: Record<string, unknown>[] | null }];

    if (templates) {
      setUserTemplates(templates.map(rowToTemplate));
    }
    if (assigns) {
      setAssignments(assigns.map((r) => ({
        id: r.id as string,
        userId: r.user_id as string,
        templateId: r.template_id as string,
        sessionId: r.session_id ? (r.session_id as string) : undefined,
        platform: r.platform ? (r.platform as string) : undefined,
        createdAt: new Date(r.created_at as string).getTime(),
      })));
    }
  }, [supabase]);

  useEffect(() => { void loadData(); }, [loadData]);

  // ── Form helpers ────────────────────────────────────────────────────────────

  function openEditor(template: PromptTemplate) {
    setSelected(template);
    setIsCreating(false);
    setForm({
      name: template.name, description: template.description,
      content: template.content, icon: template.icon,
      tags: [...template.tags], targetPlatforms: [...template.targetPlatforms],
      isDefault: template.isDefault,
    });
    setSaveError(null);
  }

  function openNew() {
    setSelected(null);
    setIsCreating(true);
    setForm({ ...EMPTY_FORM });
    setSaveError(null);
    setTagInput("");
  }

  function addTag(tag: string) {
    const t = tag.trim().toLowerCase();
    if (t && !form.tags.includes(t)) setForm((f) => ({ ...f, tags: [...f.tags, t] }));
    setTagInput("");
  }

  function removeTag(tag: string) {
    setForm((f) => ({ ...f, tags: f.tags.filter((t) => t !== tag) }));
  }

  function togglePlatform(p: TargetPlatform) {
    setForm((f) => {
      const has = f.targetPlatforms.includes(p);
      if (p === "all") return { ...f, targetPlatforms: ["all"] };
      const without = f.targetPlatforms.filter((x) => x !== "all" && (has ? x !== p : true));
      const next = has ? without : [...without, p];
      return { ...f, targetPlatforms: next.length ? next : ["all"] };
    });
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!form.name.trim() || !form.content.trim()) {
      setSaveError("Name and content are required.");
      return;
    }
    if (!userId) return;
    setSaving(true);
    setSaveError(null);

    const now = new Date().toISOString();
    const row = {
      user_id: userId,
      name: form.name.trim(),
      description: form.description.trim(),
      content: form.content,
      icon: form.icon,
      tags: form.tags,
      target_platforms: form.targetPlatforms,
      is_default: form.isDefault,
      is_system: false,
      usage_count: selected?.usageCount ?? 0,
      updated_at: now,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supa = supabase as any;
    let error;
    if (isCreating) {
      const id = crypto.randomUUID();
      ({ error } = await supa.from("prompt_templates").insert({ ...row, id, created_at: now }));
    } else if (selected) {
      if (form.isDefault) {
        await supa.from("prompt_templates").update({ is_default: false }).eq("user_id", userId).neq("id", selected.id);
      }
      ({ error } = await supa.from("prompt_templates").update(row).eq("id", selected.id));
    }

    setSaving(false);
    if (error) { setSaveError(error.message); return; }
    await loadData();
    setIsCreating(false);
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!selected || selected.isSystem) return;
    if (!confirm(`Delete "${selected.name}"? This cannot be undone.`)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supa = supabase as any;
    await supa.from("prompt_assignments").delete().eq("template_id", selected.id);
    await supa.from("prompt_templates").delete().eq("id", selected.id);
    setSelected(null);
    setIsCreating(false);
    await loadData();
  }

  // ── Assignment helpers ──────────────────────────────────────────────────────

  async function assignPlatform(platform: string) {
    if (!selected || !userId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supa = supabase as any;
    await supa.from("prompt_assignments").delete().eq("user_id", userId).eq("platform", platform).is("session_id", null);
    const { error } = await supa.from("prompt_assignments").insert({
      id: crypto.randomUUID(), user_id: userId, template_id: selected.id,
      platform, session_id: null, created_at: new Date().toISOString(),
    });
    if (!error) await loadData();
  }

  async function removeAssignment(id: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("prompt_assignments").delete().eq("id", id);
    await loadData();
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const selectedAssignments = assignments.filter((a) => a.templateId === selected?.id);

  return (
    <div className="flex h-full min-h-0 gap-0">

      {/* ── Left Sidebar ── */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-[#2A2A2A] bg-[#0A0A0A]">
        <div className="border-b border-[#2A2A2A] p-4">
          <h1 className="text-[13px] font-semibold text-[#F5F5F5] tracking-tight mb-3">Prompt Engine</h1>
          <button
            onClick={openNew}
            className="w-full rounded-[6px] bg-[#00FF88] py-2 text-[12px] font-semibold text-black transition-all hover:bg-[#00E87A] active:scale-[0.98]"
          >
            + New Template
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {userTemplates.map((t) => (
            <button
              key={t.id}
              onClick={() => openEditor(t)}
              className={`w-full text-left rounded-[6px] px-3 py-2.5 transition-all ${
                selected?.id === t.id
                  ? "bg-[#1A1A1A] ring-1 ring-[#00FF88]/20"
                  : "hover:bg-[#111111]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[14px] shrink-0">{t.icon}</span>
                  <span className={`text-[12px] font-medium truncate ${selected?.id === t.id ? "text-[#F5F5F5]" : "text-[#A0A0A0]"}`}>{t.name}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {t.isDefault && <span className="rounded-full bg-[#00FF88]/10 px-1.5 py-0.5 text-[9px] font-semibold text-[#00FF88]">default</span>}
                  {t.usageCount > 0 && <span className="rounded-full bg-[#1A1A1A] px-1.5 py-0.5 text-[9px] text-[#555]">{t.usageCount}×</span>}
                </div>
              </div>
              <p className="mt-0.5 text-[10px] text-[#555] truncate">{t.description}</p>
            </button>
          ))}

          {userTemplates.length === 0 && !isCreating && (
            <p className="px-3 py-4 text-[11px] text-[#444] text-center">No custom templates yet.<br />Create one to get started.</p>
          )}

          {/* System Templates (collapsible) */}
          <div className="mt-3">
            <button
              onClick={() => setSystemOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold text-[#444] uppercase tracking-wider hover:text-[#666]"
            >
              <span>System Templates ({SYSTEM_TEMPLATE_STUBS.length})</span>
              <span>{systemOpen ? "▲" : "▼"}</span>
            </button>
            {systemOpen && SYSTEM_TEMPLATE_STUBS.map((t) => (
              <button
                key={t.id}
                onClick={() => openEditor(t)}
                className={`w-full text-left rounded-[6px] px-3 py-2 transition-all ${
                  selected?.id === t.id ? "bg-[#1A1A1A] ring-1 ring-[#00FF88]/20" : "hover:bg-[#111111]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] shrink-0">{t.icon}</span>
                  <span className="text-[11px] text-[#666] truncate">{t.name}</span>
                  <span className="ml-auto shrink-0 rounded bg-[#1A1A1A] px-1 py-0.5 text-[8px] text-[#444] uppercase tracking-wider">built-in</span>
                </div>
              </button>
            ))}
          </div>
        </nav>
      </aside>

      {/* ── Right Editor ── */}
      <main className="flex-1 overflow-y-auto bg-[#050505]">
        {(isCreating || (selected && !selected.isSystem)) ? (
          <div className="max-w-2xl mx-auto p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-[#F5F5F5]">
                {isCreating ? "New Template" : `Edit — ${selected?.name}`}
              </h2>
              {!isCreating && selected && (
                <span className="text-[10px] text-[#444]">
                  Used {selected.usageCount} time{selected.usageCount !== 1 ? "s" : ""}
                  {selected.lastUsedAt && ` · last used ${formatDistanceToNow(selected.lastUsedAt, { addSuffix: true })}`}
                </span>
              )}
            </div>

            {/* Icon picker */}
            <div>
              <label className="block text-[11px] font-medium text-[#6B6B6B] uppercase tracking-wider mb-2">Icon</label>
              <div className="flex flex-wrap gap-2">
                {ICON_OPTIONS.map((icon) => (
                  <button
                    key={icon}
                    onClick={() => setForm((f) => ({ ...f, icon }))}
                    className={`h-9 w-9 rounded-[6px] text-[18px] transition-all ${
                      form.icon === icon
                        ? "bg-[#00FF88]/15 ring-1 ring-[#00FF88]/40"
                        : "bg-[#111] hover:bg-[#1A1A1A]"
                    }`}
                  >
                    {icon}
                  </button>
                ))}
                <input
                  type="text"
                  value={form.icon}
                  onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
                  className="h-9 w-16 rounded-[6px] bg-[#111] border border-[#2A2A2A] px-2 text-[13px] text-[#F5F5F5] outline-none focus:border-[#00FF88]/40"
                  placeholder="or type"
                  maxLength={4}
                />
              </div>
            </div>

            {/* Name */}
            <div>
              <label className="block text-[11px] font-medium text-[#6B6B6B] uppercase tracking-wider mb-2">Name *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full rounded-[6px] bg-[#111] border border-[#2A2A2A] px-3 py-2 text-[13px] text-[#F5F5F5] outline-none focus:border-[#00FF88]/40 transition-colors"
                placeholder="Senior Engineer"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-[11px] font-medium text-[#6B6B6B] uppercase tracking-wider mb-2">Description <span className="normal-case">(max 80 chars)</span></label>
              <input
                type="text"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value.slice(0, 80) }))}
                className="w-full rounded-[6px] bg-[#111] border border-[#2A2A2A] px-3 py-2 text-[13px] text-[#F5F5F5] outline-none focus:border-[#00FF88]/40 transition-colors"
                placeholder="Production-ready code with best practices"
                maxLength={80}
              />
            </div>

            {/* Content */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-[11px] font-medium text-[#6B6B6B] uppercase tracking-wider">Content *</label>
                <span className="text-[10px] text-[#444]">{form.content.length} chars</span>
              </div>
              <textarea
                value={form.content}
                onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                className="w-full min-h-[200px] rounded-[6px] bg-[#0A0A0A] border border-[#2A2A2A] px-3 py-2.5 text-[12px] text-[#F5F5F5] outline-none focus:border-[#00FF88]/40 transition-colors font-mono resize-y caret-[#00FF88]"
                placeholder="You are a senior software engineer..."
                style={{ fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" }}
              />
            </div>

            {/* Tags */}
            <div>
              <label className="block text-[11px] font-medium text-[#6B6B6B] uppercase tracking-wider mb-2">Tags</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {form.tags.map((tag) => (
                  <span key={tag} className="flex items-center gap-1 rounded-full bg-[#1A1A1A] border border-[#2A2A2A] px-2 py-0.5 text-[10px] text-[#888]">
                    {tag}
                    <button onClick={() => removeTag(tag)} className="text-[#555] hover:text-[#F87171] ml-0.5">×</button>
                  </span>
                ))}
              </div>
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(tagInput); } }}
                className="w-full rounded-[6px] bg-[#111] border border-[#2A2A2A] px-3 py-2 text-[12px] text-[#F5F5F5] outline-none focus:border-[#00FF88]/40 transition-colors"
                placeholder="type a tag + Enter"
              />
            </div>

            {/* Target platforms */}
            <div>
              <label className="block text-[11px] font-medium text-[#6B6B6B] uppercase tracking-wider mb-2">Target Platforms</label>
              <div className="flex flex-wrap gap-2">
                {PLATFORM_OPTIONS.map(({ value, label }) => {
                  const active = form.targetPlatforms.includes(value);
                  return (
                    <button
                      key={value}
                      onClick={() => togglePlatform(value)}
                      className={`rounded-full px-3 py-1 text-[11px] font-medium transition-all ${
                        active
                          ? "bg-[#00FF88]/15 text-[#00FF88] ring-1 ring-[#00FF88]/30"
                          : "bg-[#111] text-[#555] hover:text-[#888]"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Set as default */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => setForm((f) => ({ ...f, isDefault: !f.isDefault }))}
                className={`relative h-5 w-9 rounded-full transition-colors ${form.isDefault ? "bg-[#00FF88]" : "bg-[#2A2A2A]"}`}
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${form.isDefault ? "left-[18px]" : "left-0.5"}`} />
              </button>
              <label className="text-[12px] text-[#6B6B6B]">Auto-apply to all migrations (default template)</label>
            </div>

            {saveError && <p className="text-[11px] text-red-400">{saveError}</p>}

            {/* Save / Delete */}
            <div className="flex gap-3 pt-1">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 rounded-[6px] bg-[#00FF88] py-2.5 text-[12px] font-semibold text-black transition-all hover:bg-[#00E87A] disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save Template"}
              </button>
              {!isCreating && selected && (
                <button
                  onClick={handleDelete}
                  className="rounded-[6px] border border-red-500/30 px-4 py-2.5 text-[12px] font-medium text-red-400 transition-all hover:bg-red-500/10"
                >
                  Delete
                </button>
              )}
            </div>

            {/* Assignment panel */}
            {!isCreating && selected && (
              <div className="border-t border-[#1A1A1A] pt-5 space-y-3">
                <h3 className="text-[11px] font-semibold text-[#6B6B6B] uppercase tracking-wider">Quick Assign</h3>
                <p className="text-[11px] text-[#444]">Apply this template to all migrations targeting a platform.</p>
                <div className="flex flex-wrap gap-2">
                  {(["claude", "chatgpt", "gemini", "grok"] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => assignPlatform(p)}
                      className="rounded-[6px] bg-[#111] border border-[#2A2A2A] px-3 py-1.5 text-[11px] text-[#666] hover:border-[#00FF88]/30 hover:text-[#00FF88] transition-all"
                    >
                      + {p.charAt(0).toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                </div>
                {selectedAssignments.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {selectedAssignments.map((a) => (
                      <span key={a.id} className="flex items-center gap-1 rounded-full bg-[#00FF88]/10 border border-[#00FF88]/20 px-2.5 py-1 text-[10px] text-[#00FF88]">
                        {a.platform ?? a.sessionId}
                        <button onClick={() => removeAssignment(a.id)} className="ml-0.5 text-[#00FF88]/60 hover:text-red-400">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : selected?.isSystem ? (
          /* System template — read-only view */
          <div className="max-w-2xl mx-auto p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-[24px]">{selected.icon}</span>
                <div>
                  <h2 className="text-[14px] font-semibold text-[#F5F5F5]">{selected.name}</h2>
                  <p className="text-[11px] text-[#555]">{selected.description}</p>
                </div>
              </div>
              <span className="rounded bg-[#1A1A1A] px-2 py-1 text-[9px] font-semibold text-[#444] uppercase tracking-wider">built-in</span>
            </div>
            <p className="text-[11px] text-[#555]">This is a built-in system template. It cannot be edited or deleted.</p>
            <button
              onClick={() => {
                setIsCreating(true);
                setSelected(null);
                setForm({ name: `${selected.name} (custom)`, description: selected.description, content: selected.content, icon: selected.icon, tags: [...selected.tags], targetPlatforms: [...selected.targetPlatforms], isDefault: false });
              }}
              className="rounded-[6px] border border-[#00FF88]/30 px-4 py-2 text-[12px] text-[#00FF88] transition-all hover:bg-[#00FF88]/10"
            >
              Customize → Create editable copy
            </button>
          </div>
        ) : (
          /* Empty state */
          <div className="flex h-full flex-col items-center justify-center text-center p-8">
            <div className="text-[40px] mb-4">⚙️</div>
            <h2 className="text-[14px] font-semibold text-[#F5F5F5] mb-2">Select a template to edit</h2>
            <p className="text-[12px] text-[#555] mb-6">or create a new one from scratch</p>
            <button
              onClick={openNew}
              className="rounded-[6px] bg-[#00FF88] px-5 py-2.5 text-[12px] font-semibold text-black transition-all hover:bg-[#00E87A]"
            >
              + New Template
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function rowToTemplate(r: Record<string, unknown>): PromptTemplate {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    name: r.name as string,
    description: (r.description as string) ?? "",
    content: r.content as string,
    icon: (r.icon as string) ?? "⚙️",
    tags: (r.tags as string[]) ?? [],
    targetPlatforms: ((r.target_platforms as string[]) ?? ["all"]) as TargetPlatform[],
    isDefault: (r.is_default as boolean) ?? false,
    isSystem: false,
    usageCount: (r.usage_count as number) ?? 0,
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at as string).getTime() : null,
    createdAt: new Date(r.created_at as string).getTime(),
    updatedAt: new Date(r.updated_at as string).getTime(),
  };
}
