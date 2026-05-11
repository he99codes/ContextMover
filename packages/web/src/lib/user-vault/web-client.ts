"use client";
// packages/web/src/lib/user-vault/web-client.ts
//
// Gives the web app a Supabase client pointed at the USER's personal vault.
// ContextForge servers are NEVER in this data path.
// Vault config is stored in localStorage (browser-only, ContextForge cannot read it).

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const VAULT_URL_KEY  = "cf_vault_url";
const VAULT_KEY_KEY  = "cf_vault_anon_key";
const VAULT_META_KEY = "cf_vault_meta";

export interface VaultMeta {
  projectUrl: string;
  anonKey: string;
  projectRef?: string;
  projectName?: string;
  region?: string;
  connectedAt?: number;
  connectionMethod?: "oauth" | "manual";
}

/** Return a Supabase client for the user's personal vault, or null if not connected. */
export function getUserVaultClient(): SupabaseClient | null {
  if (typeof window === "undefined") return null;
  const url = localStorage.getItem(VAULT_URL_KEY);
  const key = localStorage.getItem(VAULT_KEY_KEY);
  if (!url || !key) return null;
  return createBrowserClient(url, key);
}

/** Persist vault credentials (URL + anon key are not secret — designed to be client-side). */
export function setVaultConfig(url: string, anonKey: string, meta?: Partial<VaultMeta>): void {
  localStorage.setItem(VAULT_URL_KEY, url.replace(/\/$/, ""));
  localStorage.setItem(VAULT_KEY_KEY, anonKey);
  if (meta) localStorage.setItem(VAULT_META_KEY, JSON.stringify(meta));
}

/** Clear vault credentials from localStorage (does NOT delete vault data). */
export function clearVaultConfig(): void {
  localStorage.removeItem(VAULT_URL_KEY);
  localStorage.removeItem(VAULT_KEY_KEY);
  localStorage.removeItem(VAULT_META_KEY);
}

/** Return stored vault metadata, or null if not connected. */
export function getVaultMeta(): VaultMeta | null {
  if (typeof window === "undefined") return null;
  const url = localStorage.getItem(VAULT_URL_KEY);
  const key = localStorage.getItem(VAULT_KEY_KEY);
  if (!url || !key) return null;
  const raw = localStorage.getItem(VAULT_META_KEY);
  const meta: Partial<VaultMeta> = raw ? (JSON.parse(raw) as Partial<VaultMeta>) : {};
  return { projectUrl: url, anonKey: key, ...meta };
}

/** Return true if vault credentials are present in localStorage. */
export function isVaultConnected(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    localStorage.getItem(VAULT_URL_KEY) &&
    localStorage.getItem(VAULT_KEY_KEY)
  );
}

/**
 * Parse vault config from URL search params (set by extension when opening dashboard).
 * Call on page load; returns true if params were found and stored.
 */
export function syncVaultConfigFromUrl(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const url = params.get("vault_url");
  const key = params.get("vault_key");
  if (!url || !key) return false;
  setVaultConfig(url, key, {
    projectRef:  params.get("vault_ref")  ?? undefined,
    projectName: params.get("vault_name") ?? undefined,
    region:      params.get("vault_region") ?? undefined,
    connectedAt: params.get("vault_at") ? Number(params.get("vault_at")) : undefined,
  });
  // Clean up URL without reload.
  const clean = new URL(window.location.href);
  ["vault_url", "vault_key", "vault_ref", "vault_name", "vault_region", "vault_at"].forEach(
    (k) => clean.searchParams.delete(k)
  );
  window.history.replaceState({}, "", clean.toString());
  return true;
}
