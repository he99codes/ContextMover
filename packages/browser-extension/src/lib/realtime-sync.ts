// packages/browser-extension/src/lib/realtime-sync.ts
//
// Subscribes to Supabase Postgres changes on the `sessions` table so edits and
// deletes made on the web dashboard (or any other device) mirror back into the
// extension's local IndexedDB and refresh the sidebar instantly.
//
// Direction of sync:
//   extension capture ── upsert ──▶ Supabase ── realtime ──▶ web dashboard
//   web edit/delete   ── mutate ──▶ Supabase ── realtime ──▶ extension (THIS FILE)

import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "./supabase";
import { db } from "./db";
import { forgetSession } from "./session-id";
import type { ContextSession, Platform } from "./types";

const PLATFORM_URL_GLOBS = [
  "https://claude.ai/*",
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*",
  "https://grok.com/*",
  "https://grok.x.ai/*",
];

async function broadcastForgetToTabs(sessionId: string): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: PLATFORM_URL_GLOBS });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        chrome.tabs.sendMessage(
          tab.id,
          { type: "SESSION_FORGOTTEN", sessionId },
          () => { void chrome.runtime.lastError; }
        );
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

let channel: RealtimeChannel | null = null;
let subscribedUserId: string | null = null;

function rowToSession(row: Record<string, unknown>): ContextSession {
  return {
    id: row.id as string,
    platform: row.platform as Platform,
    title: (row.title as string | null) ?? "",
    messages: Array.isArray(row.messages)
      ? (row.messages as ContextSession["messages"])
      : [],
    createdAt: new Date(row.created_at as string).getTime(),
    updatedAt: new Date(row.updated_at as string).getTime(),
  };
}

async function notifySidebar() {
  // Only broadcast if an extension view (sidebar/popup) is actually open.
  // Otherwise Chrome's runtime.sendMessage rejects with "Receiving end does
  // not exist", which surfaces as a noisy error in the service worker console
  // even when the promise rejection is caught.
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [
        "SIDE_PANEL" as chrome.runtime.ContextType,
        "POPUP" as chrome.runtime.ContextType,
        "TAB" as chrome.runtime.ContextType,
      ],
    });
    if (!contexts || contexts.length === 0) return;
    await chrome.runtime.sendMessage({ type: "SESSIONS_UPDATED" });
  } catch {
    /* no listener ready — safe to ignore */
  }
}

/**
 * Start listening for realtime changes scoped to the given user. Safe to call
 * repeatedly — it'll only create one subscription per user.
 */
export async function startRealtimeSync(): Promise<void> {
  if (!isSupabaseConfigured) return;

  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) {
    console.log("[ContextForge:realtime] skip subscribe — not signed in");
    return;
  }

  if (channel && subscribedUserId === userId) {
    console.log("[ContextForge:realtime] already subscribed for this user");
    return;
  }

  // User changed → tear down the old channel before resubscribing.
  if (channel) await stopRealtimeSync();

  subscribedUserId = userId;
  channel = supabase
    .channel(`sessions-sync-${userId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "sessions",
        filter: `user_id=eq.${userId}`,
      },
      async (payload) => {
        try {
          if (payload.eventType === "DELETE") {
            const id = (payload.old as { id?: string })?.id;
            if (!id) return;
            console.log(`[ContextForge:realtime] DELETE ${id}`);
            await db.deleteSession(id);
            await forgetSession(id);
            void broadcastForgetToTabs(id);
            notifySidebar();
            return;
          }

          if (
            payload.eventType === "INSERT" ||
            payload.eventType === "UPDATE"
          ) {
            const session = rowToSession(payload.new as Record<string, unknown>);
            console.log(
              `[ContextForge:realtime] ${payload.eventType} ${session.id} (${session.messages.length} msgs)`
            );
            await db.saveSession(session);
            notifySidebar();
          }
        } catch (err) {
          console.warn("[ContextForge:realtime] handler error:", err);
        }
      }
    )
    .subscribe((status) => {
      console.log(`[ContextForge:realtime] channel status: ${status}`);
    });
}

export async function stopRealtimeSync(): Promise<void> {
  if (channel) {
    await supabase.removeChannel(channel);
    channel = null;
    subscribedUserId = null;
    console.log("[ContextForge:realtime] unsubscribed");
  }
}
