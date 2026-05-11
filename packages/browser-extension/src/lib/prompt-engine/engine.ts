// packages/browser-extension/src/lib/prompt-engine/engine.ts
//
// Phase 1: Predefined template system. Zero AI. Zero API calls.
// Pure template management + context merging. < 50ms load, < 100ms merge.

import { getDb } from "@/lib/db";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { SYSTEM_TEMPLATES } from "./default-templates";
import type { PromptTemplate, PromptTemplateId, PromptAssignment, PromptMergeResult } from "./types";

const CAVEMAN_ADDITION = `
Response style: Caveman mode.
No filler. No pleasantries. No hedging.
Code write normal. Technical terms exact.
Answer then stop.`;

// ─────────────────────────────────────────────────────────────────────────────
// PromptEngine
// ─────────────────────────────────────────────────────────────────────────────

export class PromptEngine {
  private templates: Map<string, PromptTemplate> = new Map();
  private assignments: PromptAssignment[] = [];
  private initialized = false;

  // ── Initialization ─────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load system templates
    for (const t of SYSTEM_TEMPLATES) {
      this.templates.set(t.id, t);
    }

    // Load user templates from IndexedDB
    try {
      const db = await getDb();
      const userTemplates: PromptTemplate[] = await db.getAll("prompt_templates");
      for (const t of userTemplates) {
        this.templates.set(t.id, t);
      }

      // Load assignments
      this.assignments = await db.getAll("prompt_assignments");
    } catch (err) {
      console.warn("[ContextMover:prompt-engine] IndexedDB load failed, continuing with system templates:", err);
    }

    this.initialized = true;

    const systemCount = SYSTEM_TEMPLATES.length;
    const userCount = [...this.templates.values()].filter((t) => !t.isSystem).length;
    console.log(
      `[ContextMover:prompt-engine] initialized systemTemplates=${systemCount} userTemplates=${userCount} assignments=${this.assignments.length}`
    );
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async getAllTemplates(): Promise<{ system: PromptTemplate[]; user: PromptTemplate[] }> {
    await this.ensureInitialized();
    const all = [...this.templates.values()];
    const system = all
      .filter((t) => t.isSystem)
      .sort((a, b) => b.usageCount - a.usageCount);
    const user = all
      .filter((t) => !t.isSystem)
      .sort((a, b) => b.usageCount - a.usageCount);
    return { system, user };
  }

  async getTemplate(id: string): Promise<PromptTemplate | null> {
    await this.ensureInitialized();
    return this.templates.get(id) ?? null;
  }

  async getTemplateForSession(
    sessionId: string,
    platform: string
  ): Promise<PromptTemplate | null> {
    await this.ensureInitialized();

    // Priority 1: assignment for this specific session
    const sessionAssignment = this.assignments.find((a) => a.sessionId === sessionId);
    if (sessionAssignment) return this.templates.get(sessionAssignment.templateId) ?? null;

    // Priority 2: assignment for this platform
    const platformAssignment = this.assignments.find((a) => a.platform === platform);
    if (platformAssignment) return this.templates.get(platformAssignment.templateId) ?? null;

    // Priority 3: user's default template
    const defaultTemplate = [...this.templates.values()].find(
      (t) => !t.isSystem && t.isDefault
    );
    if (defaultTemplate) return defaultTemplate;

    return null;
  }

  // ── Merge ──────────────────────────────────────────────────────────────────

  async mergeWithContext(
    context: string,
    templateId: string,
    targetPlatform: string,
    caveman: boolean
  ): Promise<PromptMergeResult> {
    await this.ensureInitialized();

    const template = this.templates.get(templateId);
    if (!template) throw new Error(`[ContextMover:prompt-engine] template not found: ${templateId}`);

    // Build final template content, appending caveman instruction if needed
    const templateContent = caveman
      ? template.content + CAVEMAN_ADDITION
      : template.content;

    const finalContext = this.buildMergedContext(context, { ...template, content: templateContent }, targetPlatform);

    void this.incrementUsage(templateId);

    return {
      finalContext,
      templateUsed: template,
      templateName: template.name,
      mergeStrategy: "wrap",
      stats: {
        templateLength: templateContent.length,
        contextLength: context.length,
        totalLength: finalContext.length,
        estimatedTokens: Math.ceil(finalContext.length / 4),
      },
    };
  }

  private buildMergedContext(
    context: string,
    template: PromptTemplate,
    platform: string
  ): string {
    if (platform === "claude") {
      // Inject <prompt_engine> block inside <context_migration> after </meta>
      const injection = [
        `  <prompt_engine>`,
        `    <template_name>${template.name}</template_name>`,
        `    <template_icon>${template.icon}</template_icon>`,
        `    <instructions>`,
        template.content.split("\n").map((l) => `      ${l}`).join("\n"),
        `    </instructions>`,
        `  </prompt_engine>`,
      ].join("\n");

      const metaCloseIdx = context.indexOf("</meta>");
      if (metaCloseIdx !== -1) {
        const insertAt = metaCloseIdx + "</meta>".length;
        return context.slice(0, insertAt) + "\n" + injection + context.slice(insertAt);
      }
      // Fallback: prepend if <meta> not found
      return injection + "\n\n" + context;
    }

    if (platform === "gemini") {
      // Plain text prepend
      const block = [
        `[SYSTEM INSTRUCTIONS — ${template.name}]`,
        template.content,
        `---`,
        ``,
      ].join("\n");
      return block + context;
    }

    // ChatGPT, Grok, Perplexity, DeepSeek — Markdown prepend
    const block = [
      `## System Instructions (${template.icon} ${template.name})`,
      ``,
      template.content,
      ``,
      `---`,
      ``,
    ].join("\n");
    return block + context;
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async saveUserTemplate(
    partial: Omit<PromptTemplate, "id" | "userId" | "isSystem" | "usageCount" | "lastUsedAt" | "createdAt" | "updatedAt">
  ): Promise<PromptTemplate> {
    await this.ensureInitialized();

    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id ?? "local";

    const now = Date.now();
    const template: PromptTemplate = {
      ...partial,
      id: crypto.randomUUID(),
      userId,
      isSystem: false,
      usageCount: 0,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const db = await getDb();
    await db.put("prompt_templates", template);
    this.templates.set(template.id, template);

    void this.syncTemplateToCloud(template);

    return template;
  }

  async updateUserTemplate(
    id: string,
    updates: Partial<Pick<PromptTemplate, "name" | "description" | "content" | "icon" | "tags" | "targetPlatforms" | "isDefault">>
  ): Promise<PromptTemplate> {
    await this.ensureInitialized();

    const existing = this.templates.get(id);
    if (!existing) throw new Error(`Template not found: ${id}`);
    if (existing.isSystem) throw new Error("Cannot modify a system template.");

    const updated: PromptTemplate = { ...existing, ...updates, updatedAt: Date.now() };
    const db = await getDb();
    await db.put("prompt_templates", updated);
    this.templates.set(id, updated);

    void this.syncTemplateToCloud(updated);

    return updated;
  }

  async deleteUserTemplate(id: string): Promise<void> {
    await this.ensureInitialized();

    const existing = this.templates.get(id);
    if (!existing) return;
    if (existing.isSystem) throw new Error("Cannot delete a system template.");

    // Remove all assignments pointing to this template
    this.assignments = this.assignments.filter((a) => a.templateId !== id);

    const db = await getDb();
    await db.delete("prompt_templates", id);

    // Remove assignments from store
    const allAssignments: PromptAssignment[] = await db.getAll("prompt_assignments");
    for (const a of allAssignments) {
      if (a.templateId === id) await db.delete("prompt_assignments", a.id);
    }

    this.templates.delete(id);

    void this.deleteTemplateFromCloud(id);
  }

  // ── Assignments ────────────────────────────────────────────────────────────

  async assignTemplate(
    templateId: string,
    target: { sessionId?: string; platform?: string }
  ): Promise<void> {
    await this.ensureInitialized();

    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id ?? "local";

    // Remove any existing assignment for this exact target
    await this.removeAssignment(target);

    const assignment: PromptAssignment = {
      id: crypto.randomUUID(),
      userId,
      templateId,
      sessionId: target.sessionId,
      platform: target.platform,
      createdAt: Date.now(),
    };

    const db = await getDb();
    await db.put("prompt_assignments", assignment);
    this.assignments.push(assignment);

    void this.syncAssignmentToCloud(assignment);
  }

  async removeAssignment(target: { sessionId?: string; platform?: string }): Promise<void> {
    await this.ensureInitialized();

    const toRemove = this.assignments.filter((a) => {
      if (target.sessionId) return a.sessionId === target.sessionId;
      if (target.platform) return a.platform === target.platform;
      return false;
    });

    const db = await getDb();
    for (const a of toRemove) {
      await db.delete("prompt_assignments", a.id);
    }

    this.assignments = this.assignments.filter((a) => !toRemove.includes(a));
  }

  async setDefault(templateId: string): Promise<void> {
    await this.ensureInitialized();

    const db = await getDb();
    const userTemplates = [...this.templates.values()].filter((t) => !t.isSystem);

    for (const t of userTemplates) {
      const updated: PromptTemplate = { ...t, isDefault: t.id === templateId, updatedAt: Date.now() };
      await db.put("prompt_templates", updated);
      this.templates.set(t.id, updated);
      void this.syncTemplateToCloud(updated);
    }
  }

  async incrementUsage(templateId: string): Promise<void> {
    await this.ensureInitialized();

    const t = this.templates.get(templateId);
    if (!t) return;

    const updated: PromptTemplate = { ...t, usageCount: t.usageCount + 1, lastUsedAt: Date.now(), updatedAt: Date.now() };
    this.templates.set(templateId, updated);

    // Only persist user templates — system templates are ephemeral in-memory
    if (!t.isSystem) {
      try {
        const db = await getDb();
        await db.put("prompt_templates", updated);
      } catch { /* non-critical */ }
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getStats(): Promise<{
    totalTemplates: number;
    userTemplates: number;
    totalUsage: number;
    mostUsed: PromptTemplate | null;
    topPlatform: string | null;
  }> {
    await this.ensureInitialized();

    const all = [...this.templates.values()];
    const userTemplates = all.filter((t) => !t.isSystem);
    const totalUsage = all.reduce((sum, t) => sum + t.usageCount, 0);
    const mostUsed = all.reduce<PromptTemplate | null>(
      (best, t) => (!best || t.usageCount > best.usageCount ? t : best),
      null
    );

    const platformCounts: Record<string, number> = {};
    for (const a of this.assignments) {
      if (a.platform) platformCounts[a.platform] = (platformCounts[a.platform] ?? 0) + 1;
    }
    const topPlatform = Object.entries(platformCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
      totalTemplates: all.length,
      userTemplates: userTemplates.length,
      totalUsage,
      mostUsed,
      topPlatform,
    };
  }

  // ── Cloud sync helpers (fire-and-forget) ───────────────────────────────────

  private async syncTemplateToCloud(template: PromptTemplate): Promise<void> {
    if (!isSupabaseConfigured) return;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const row = {
        id: template.id,
        user_id: user.id,
        name: template.name,
        description: template.description,
        content: template.content,
        icon: template.icon,
        tags: template.tags,
        target_platforms: template.targetPlatforms,
        is_default: template.isDefault,
        is_system: template.isSystem,
        usage_count: template.usageCount,
        last_used_at: template.lastUsedAt ? new Date(template.lastUsedAt).toISOString() : null,
        updated_at: new Date(template.updatedAt).toISOString(),
      };
      const { error } = await supabase.from("prompt_templates").upsert(row, { onConflict: "id" });
      if (error) console.warn("[ContextMover:prompt-engine] cloud sync failed:", error.message);
    } catch (err) {
      console.warn("[ContextMover:prompt-engine] cloud sync threw:", err);
    }
  }

  private async deleteTemplateFromCloud(id: string): Promise<void> {
    if (!isSupabaseConfigured) return;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from("prompt_templates").delete().eq("id", id).eq("user_id", user.id);
    } catch (err) {
      console.warn("[ContextMover:prompt-engine] cloud delete threw:", err);
    }
  }

  private async syncAssignmentToCloud(assignment: PromptAssignment): Promise<void> {
    if (!isSupabaseConfigured) return;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const row = {
        id: assignment.id,
        user_id: user.id,
        template_id: assignment.templateId,
        session_id: assignment.sessionId ?? null,
        platform: assignment.platform ?? null,
        created_at: new Date(assignment.createdAt).toISOString(),
      };
      const { error } = await supabase.from("prompt_assignments").upsert(row, { onConflict: "id" });
      if (error) console.warn("[ContextMover:prompt-engine] assignment sync failed:", error.message);
    } catch (err) {
      console.warn("[ContextMover:prompt-engine] assignment sync threw:", err);
    }
  }
}

export const promptEngine = new PromptEngine();
