// packages/browser-extension/src/lib/user-vault/connector.ts
//
// UserVaultConnector — manages the user's personal Supabase connection.
// ContextForge servers are NEVER in this data path.
// All session/memory data goes directly to the USER's Supabase project.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

import { WEBAPP_URL as APP_URL } from "@/config/urls";
const MANAGEMENT_API = "https://api.supabase.com/v1";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CF_CLIENT_ID: string = (import.meta as any).env?.VITE_SUPABASE_MANAGEMENT_CLIENT_ID ?? "";

const STORAGE_KEY = "cf_vault_encrypted";

export interface VaultConfig {
  projectUrl: string;
  anonKey: string;
  projectRef: string;
  projectName: string;
  region: string;
  connectedAt: number;
  connectionMethod: "oauth" | "manual";
}

// Full vault schema SQL — mirrors schema.sql for programmatic deployment.
const VAULT_SCHEMA_SQL = `
create extension if not exists "uuid-ossp";
create table if not exists cf_sessions (
  id text primary key, platform text not null, title text,
  messages jsonb not null default '[]', message_count integer default 0,
  user_message_count integer default 0, assistant_message_count integer default 0,
  captured_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists cf_migrations (
  id uuid primary key default uuid_generate_v4(), session_id text references cf_sessions(id),
  source_platform text, target_platform text, tier integer, template_id text,
  compression_ratio float, migrated_at timestamptz default now()
);
create table if not exists cf_nodes (
  id text primary key, type text not null, label text not null, content text,
  metadata jsonb default '{}', tags text[] default '{}', importance float default 0.5,
  source text not null, session_id text references cf_sessions(id),
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists cf_edges (
  id text primary key,
  source_id text references cf_nodes(id) on delete cascade,
  target_id text references cf_nodes(id) on delete cascade,
  type text not null, weight float default 0.5, reason text, auto boolean default true,
  created_at timestamptz default now()
);
create table if not exists cf_github_repos (
  id text primary key, owner text not null, repo text not null,
  branch text default 'main', last_indexed_at timestamptz, file_count integer default 0,
  created_at timestamptz default now()
);
create table if not exists cf_ide_snapshots (
  id text primary key, workspace_name text, active_file text, open_files text[],
  git_branch text, git_diff_summary text, diagnostics jsonb default '[]',
  captured_at timestamptz default now()
);
create table if not exists cf_prompt_templates (
  id text primary key, name text not null, description text, content text not null,
  icon text default '⚙️', tags text[] default '{}', target_platforms text[] default '{all}',
  is_default boolean default false, usage_count integer default 0,
  last_used_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists cf_sessions_platform_idx on cf_sessions(platform);
create index if not exists cf_sessions_updated_idx  on cf_sessions(updated_at desc);
create index if not exists cf_nodes_type_idx        on cf_nodes(type);
create index if not exists cf_edges_source_idx      on cf_edges(source_id);
create index if not exists cf_edges_target_idx      on cf_edges(target_id);
alter publication supabase_realtime add table cf_sessions;
`;

export class UserVaultConnector {

  // ── OAuth (one-click) ──────────────────────────────────────────────────────

  async initiateOAuth(): Promise<void> {
    const verifier = this.generateCodeVerifier();
    const challenge = await this.generateCodeChallenge(verifier);
    await chrome.storage.session.set({ cf_vault_pkce_verifier: verifier });

    const params = new URLSearchParams({
      client_id: CF_CLIENT_ID,
      redirect_uri: `${APP_URL}/settings/vault/callback`,
      response_type: "code",
      scope: "projects:create projects:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    await chrome.tabs.create({
      url: `${MANAGEMENT_API}/oauth/authorize?${params}`,
    });

    // Monitor tabs for the OAuth callback redirect.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("[ContextForge:vault] OAuth timed out after 5 minutes"));
      }, 5 * 60 * 1_000);

      const listener = async (
        tabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
        tab: chrome.tabs.Tab
      ) => {
        if (changeInfo.status !== "complete") return;
        const url = tab.url ?? "";
        if (!url.startsWith(`${APP_URL}/settings/vault/callback`)) return;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        try {
          const code = new URL(url).searchParams.get("code");
          if (!code) throw new Error("[ContextForge:vault] No code in OAuth callback");
          await this.handleOAuthCallback(code);
          // Close the OAuth tab
          chrome.tabs.remove(tabId).catch(() => { /* tab may already be closed */ });
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  async handleOAuthCallback(code: string): Promise<VaultConfig> {
    const stored = await chrome.storage.session.get("cf_vault_pkce_verifier");
    const verifier = stored["cf_vault_pkce_verifier"] as string | undefined;
    if (!verifier) throw new Error("[ContextForge:vault] PKCE verifier missing from session storage");

    // Exchange code for Management API access token.
    const tokenRes = await fetch(`${MANAGEMENT_API}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: `${APP_URL}/settings/vault/callback`,
        client_id: CF_CLIENT_ID,
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`[ContextForge:vault] Token exchange failed: ${await tokenRes.text()}`);
    }
    const { access_token: mgmtToken } = await tokenRes.json() as { access_token: string };
    await chrome.storage.session.remove("cf_vault_pkce_verifier");

    // List existing projects.
    const projectsRes = await fetch(`${MANAGEMENT_API}/projects`, {
      headers: { Authorization: `Bearer ${mgmtToken}` },
    });
    const projects = await projectsRes.json() as Array<{
      ref: string; name: string; region: string; status: string;
    }>;

    let project = projects.find((p) => p.name === "contextforge-memory");

    if (!project) {
      const region = this.detectNearestRegion();
      const dbPass = this.generateSecurePassword();
      const orgId = await this.getFirstOrgId(mgmtToken);

      const createRes = await fetch(`${MANAGEMENT_API}/projects`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mgmtToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "contextforge-memory",
          db_pass: dbPass,
          region,
          organization_id: orgId,
        }),
      });
      if (!createRes.ok) {
        throw new Error(`[ContextForge:vault] Project creation failed: ${await createRes.text()}`);
      }
      const created = await createRes.json() as { ref: string; name: string; region: string };
      project = await this.waitForProject(mgmtToken, created.ref);
    }

    // Get anon key.
    const keysRes = await fetch(`${MANAGEMENT_API}/projects/${project.ref}/api-keys`, {
      headers: { Authorization: `Bearer ${mgmtToken}` },
    });
    const keys = await keysRes.json() as Array<{ name: string; api_key: string }>;
    const anonKey = keys.find((k) => k.name === "anon")?.api_key ?? "";

    const projectUrl = `https://${project.ref}.supabase.co`;

    // Deploy vault schema via Management API.
    await this.runVaultSchemaViaAPI(mgmtToken, project.ref);

    const config: VaultConfig = {
      projectUrl,
      anonKey,
      projectRef: project.ref,
      projectName: project.name,
      region: project.region,
      connectedAt: Date.now(),
      connectionMethod: "oauth",
    };

    await this.saveConfig(config);
    console.log("[ContextForge:vault] Schema deployed successfully");
    return config;
  }

  // ── Manual (URL + anon key) ────────────────────────────────────────────────

  async connectManual(url: string, anonKey: string): Promise<VaultConfig> {
    const projectUrl = url.replace(/\/$/, "");
    const urlMatch = projectUrl.match(/^https:\/\/([a-z0-9]+)\.supabase\.co$/);
    if (!urlMatch) {
      throw new Error(
        "[ContextForge:vault] Invalid Supabase URL. Expected: https://xxxx.supabase.co"
      );
    }
    const ref = urlMatch[1];

    // Test connection — check if cf_sessions table exists.
    const client = createSupabaseClient(projectUrl, anonKey);
    const { error } = await client.from("cf_sessions").select("id").limit(1);

    if (error?.code === "42P01") {
      // Table doesn't exist — schema not deployed.
      throw new Error(
        "[ContextForge:vault] Vault schema not found in your Supabase project. " +
        "Please run the setup SQL in your Supabase Dashboard → SQL Editor. " +
        "Copy the SQL from Settings → Vault → Setup SQL."
      );
    } else if (error && !error.message.includes("Results contain 0 rows")) {
      throw new Error(`[ContextForge:vault] Connection test failed: ${error.message}`);
    }

    const config: VaultConfig = {
      projectUrl,
      anonKey,
      projectRef: ref,
      projectName: "My Vault",
      region: this.detectNearestRegion(),
      connectedAt: Date.now(),
      connectionMethod: "manual",
    };

    await this.saveConfig(config);
    return config;
  }

  // ── Schema deployment ──────────────────────────────────────────────────────

  async runVaultSchema(_client: SupabaseClient): Promise<void> {
    // For manual connections, anon key cannot run DDL.
    // Use runVaultSchemaViaAPI() (OAuth) or manual SQL copy.
    console.log("[ContextForge:vault] Schema deployment requires Management API token (OAuth flow)");
  }

  private async runVaultSchemaViaAPI(mgmtToken: string, projectRef: string): Promise<void> {
    const res = await fetch(`${MANAGEMENT_API}/projects/${projectRef}/database/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mgmtToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: VAULT_SCHEMA_SQL }),
    });
    if (!res.ok) {
      throw new Error(`[ContextForge:vault] Schema deployment failed: ${await res.text()}`);
    }
    console.log("[ContextForge:vault] Schema deployed successfully");
  }

  // ── Client access ──────────────────────────────────────────────────────────

  async getClient(): Promise<SupabaseClient | null> {
    try {
      const config = await this.loadConfig();
      if (!config) return null;
      return createSupabaseClient(config.projectUrl, config.anonKey);
    } catch {
      return null;
    }
  }

  async getConfig(): Promise<VaultConfig | null> {
    try {
      return await this.loadConfig();
    } catch {
      return null;
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async testConnection(): Promise<{
    connected: boolean;
    projectName?: string;
    region?: string;
    sessionsCount?: number;
  }> {
    const client = await this.getClient();
    if (!client) return { connected: false };
    try {
      const config = await this.loadConfig();
      const { count } = await client
        .from("cf_sessions")
        .select("id", { count: "exact", head: true });
      return {
        connected: true,
        projectName: config?.projectName,
        region: config?.region,
        sessionsCount: count ?? 0,
      };
    } catch {
      return { connected: false };
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEY);
    console.log("[ContextForge:vault] Disconnected from personal vault");
  }

  async deleteAllVaultData(): Promise<void> {
    const client = await this.getClient();
    if (!client) throw new Error("[ContextForge:vault] Not connected to a vault");

    const tables = [
      "cf_edges", "cf_nodes", "cf_migrations",
      "cf_ide_snapshots", "cf_github_repos", "cf_prompt_templates", "cf_sessions",
    ];
    for (const table of tables) {
      try {
        // Delete all rows by matching non-empty id (every row has one).
        await client.from(table).delete().neq("id", "\x00");
      } catch { /* table may not exist — safe to ignore */ }
    }
    console.log("[ContextForge:vault] All vault data deleted");
  }

  // ── Encryption (AES-256-GCM, key from PBKDF2 over stable user ID) ─────────

  private async encryptConfig(config: VaultConfig, userToken: string): Promise<string> {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv   = crypto.getRandomValues(new Uint8Array(12));

    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(userToken), "PBKDF2", false, ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      enc.encode(JSON.stringify(config))
    );

    // Layout: [16 bytes salt][12 bytes IV][ciphertext]
    const combined = new Uint8Array(16 + 12 + ciphertext.byteLength);
    combined.set(salt, 0);
    combined.set(iv, 16);
    combined.set(new Uint8Array(ciphertext), 28);

    return btoa(String.fromCharCode(...combined));
  }

  private async decryptConfig(encryptedStr: string, userToken: string): Promise<VaultConfig> {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const combined = Uint8Array.from(atob(encryptedStr), (c) => c.charCodeAt(0));

    const salt       = combined.slice(0, 16);
    const iv         = combined.slice(16, 28);
    const ciphertext = combined.slice(28);

    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(userToken), "PBKDF2", false, ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(dec.decode(decrypted)) as VaultConfig;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async saveConfig(config: VaultConfig): Promise<void> {
    const key = await this.getStableUserKey();
    const encrypted = await this.encryptConfig(config, key);
    await chrome.storage.local.set({ [STORAGE_KEY]: encrypted });
  }

  private async loadConfig(): Promise<VaultConfig | null> {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const encrypted = stored[STORAGE_KEY] as string | undefined;
    if (!encrypted) return null;
    const key = await this.getStableUserKey();
    return this.decryptConfig(encrypted, key);
  }

  private async getStableUserKey(): Promise<string> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.id) {
      throw new Error("[ContextForge:vault] Not authenticated — cannot access vault config");
    }
    return user.id; // Stable across token refreshes; unique per user on this device.
  }

  private detectNearestRegion(): string {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    if (/Asia\/(Kolkata|Colombo|Dhaka|Kathmandu|Karachi|Lahore)/.test(tz)) return "ap-south-1";
    if (/Asia\//.test(tz)) return "ap-southeast-1";
    if (/Europe\//.test(tz)) return "eu-central-1";
    if (/America\/(New_York|Toronto|Montreal|Halifax)/.test(tz)) return "us-east-1";
    if (/America\//.test(tz)) return "us-west-1";
    return "us-east-1";
  }

  private generateSecurePassword(): string {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
    const arr = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(arr).map((b) => chars[b % chars.length]).join("");
  }

  private generateCodeVerifier(): string {
    const arr = crypto.getRandomValues(new Uint8Array(64));
    return btoa(String.fromCharCode(...arr))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
      .slice(0, 128);
  }

  private async generateCodeChallenge(verifier: string): Promise<string> {
    const enc = new TextEncoder();
    const hash = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  private async getFirstOrgId(mgmtToken: string): Promise<string> {
    const res = await fetch(`${MANAGEMENT_API}/organizations`, {
      headers: { Authorization: `Bearer ${mgmtToken}` },
    });
    const orgs = await res.json() as Array<{ id: string }>;
    if (!orgs.length) throw new Error("[ContextForge:vault] No Supabase organizations found");
    return orgs[0].id;
  }

  private async waitForProject(
    mgmtToken: string,
    ref: string,
    maxWaitMs = 300_000
  ): Promise<{ ref: string; name: string; region: string; status: string }> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const res = await fetch(`${MANAGEMENT_API}/projects/${ref}`, {
        headers: { Authorization: `Bearer ${mgmtToken}` },
      });
      const project = await res.json() as {
        ref: string; name: string; region: string; status: string;
      };
      if (project.status === "ACTIVE_HEALTHY") return project;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error("[ContextForge:vault] Project provisioning timed out (5 min)");
  }
}

export const userVault = new UserVaultConnector();
