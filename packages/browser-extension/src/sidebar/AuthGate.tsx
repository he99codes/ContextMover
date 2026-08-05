/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { WEBAPP_URL } from "../config/urls";

type AuthUser = { id: string; email?: string | null } | null;

interface AuthGateProps {
  children: (user: NonNullable<AuthUser>, signOut: () => void) => ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AuthUser>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  useEffect(() => {
    void refreshUser();

    const onMessage = (msg: { type: string }) => {
      if (msg.type === "AUTH_STATE_CHANGED") void refreshUser();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  function refreshUser() {
    chrome.runtime.sendMessage({ type: "AUTH_GET_USER" }, (res) => {
      void chrome.runtime.lastError; // suppress unchecked error
      setUser(res?.user ?? null);
      setLoading(false);
    });
  }

  function signOut() {
    chrome.runtime.sendMessage({ type: "AUTH_SIGN_OUT" }, () => {
      void chrome.runtime.lastError;
      setUser(null);
    });
  }

  function handleWebAuthFallback() {
    window.open(`${WEBAPP_URL}/auth?ext_login=true`, "_blank");
    setInfo("Opened login in a new browser tab. Complete sign-in there to sync automatically.");
  }

  async function handleGoogleSignIn() {
    setGoogleLoading(true);
    setError(null);
    setInfo(null);
    try {
      // Use the id_token flow directly (bypass Supabase PKCE which has redirect URL issues)
      // This uses the extension's own OAuth client from manifest.json
      const clientId = chrome.runtime.getManifest().oauth2?.client_id;
      if (!clientId) throw new Error("No oauth2.client_id in manifest");
      const redirectUri = chrome.identity.getRedirectURL();
      const nonce = crypto.randomUUID();
      const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(clientId)}` +
        `&response_type=id_token` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=openid%20email%20profile` +
        `&nonce=${nonce}` +
        `&prompt=consent`;

      console.log("[CM:auth] Using id_token flow with redirect:", redirectUri);

      const idTokenUrl = await new Promise<string | undefined>((resolve) => {
        chrome.identity.launchWebAuthFlow(
          { url: googleAuthUrl, interactive: true },
          (url) => { 
            console.log("[CM:auth] launchWebAuthFlow callback URL:", url);
            if (chrome.runtime.lastError) {
              console.error("[CM:auth] launchWebAuthFlow error:", chrome.runtime.lastError.message);
            }
            resolve(url); 
            void chrome.runtime.lastError; 
          }
        );
      });

      if (!idTokenUrl) {
        setError("Popup blocked or cancelled (common on Brave). Use 'Sign in via Web Tab' below.");
        setGoogleLoading(false);
        return;
      }

      const hashFragment = new URL(idTokenUrl).hash.slice(1);
      const idToken = new URLSearchParams(hashFragment).get("id_token");
      if (!idToken) {
        setError("No id_token received. Use 'Sign in via Web Tab' below.");
        setGoogleLoading(false);
        return;
      }

      console.log("[CM:auth] Got id_token, exchanging with backend...");
      const res = await new Promise<{ user?: AuthUser; error?: string; message?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { type: "AUTH_GOOGLE_SIGN_IN", payload: { idToken, nonce } },
          (r) => {
            console.log("[CM:auth] Service worker response:", r);
            resolve(r ?? { error: "No response" });
          }
        );
      });
      
      console.log("[CM:auth] Parsed response:", res);
      if (res.user) {
        setUser(res.user);
        setGoogleLoading(false);
        return;
      }
      if (res.error) {
        setError(res.message ?? res.error);
        setGoogleLoading(false);
        return;
      }
      
      setError("Sign-in failed — please try again or use 'Sign in via Web Tab'");
      setGoogleLoading(false);
    } catch (err) {
      console.error("[CM:auth] OAuth error:", err);
      setError("Sign-in failed — use 'Sign in via Web Tab' below.");
      setGoogleLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);

    chrome.runtime.sendMessage(
      { type: "AUTH_SIGN_IN", payload: { email: email.trim(), password } },
      (res) => {
        setSubmitting(false);
        if (res?.error) {
          const m: string = res.error;
          setError(m.toLowerCase().includes("invalid login credentials")
            ? "Invalid email or password. If you signed up with Google, use the Google or Web Tab button below."
            : m);
          return;
        }
        setUser(res?.user ?? null);
      }
    );
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0A0A0A] text-xs text-[#6B6B6B]">
        Loading…
      </div>
    );
  }

  if (user) {
    return (
      <div className="flex h-screen flex-col bg-[#0A0A0A] text-[#F5F5F5]">
        <div className="flex items-center justify-between border-b border-[#2A2A2A] px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-block h-2 w-2 rounded-full bg-[#00FF88] shadow-[0_0_8px_rgba(0,255,136,0.7)] animate-pulse-green" />
            <span className="truncate text-[11px] text-[#6B6B6B]">
              Signed in
            </span>
          </div>
          <button
            onClick={signOut}
            className="text-[10px] text-[#6B6B6B] hover:text-[#FF4444] uppercase tracking-wider transition-colors"
          >
            Sign out
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {children(user, signOut)}
        </div>
      </div>
    );
  }

  // ── Sign-in / sign-up form ───────────────────────────────────────────────
  return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#0A0A0A] px-6 text-[#F5F5F5]">
      <div className="w-full max-w-xs">
        <div className="mb-6 text-center">
          <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-[8px] bg-[#00FF88]">
            <span className="text-lg font-bold text-black">CM</span>
          </div>
          <h1 className="text-base font-semibold tracking-tight text-[#F5F5F5]">ContextMover</h1>
          <p className="mt-1 text-[11px] text-[#6B6B6B]">
            Sign in to sync with the web dashboard
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-[#6B6B6B]">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-3 py-2 text-sm text-[#F5F5F5] placeholder:text-[#6B6B6B] outline-none focus:border-[#00FF88]"
              placeholder="you@example.com"
              autoFocus
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-[#6B6B6B]">
              Password
            </label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-3 py-2 text-sm text-[#F5F5F5] placeholder:text-[#6B6B6B] outline-none focus:border-[#00FF88]"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="rounded-[4px] border border-[#00FF88]/30 bg-[#00FF88]/10 px-2 py-1.5 text-[11px] text-[#00FF88]">
              {error}
            </div>
          )}
          {info && (
            <div className="rounded-[4px] border border-[#00FF88]/30 bg-[#00FF88]/10 px-2 py-1.5 text-[11px] text-[#00FF88]">
              {info}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-[4px] bg-[#00FF88] py-2 text-sm font-semibold text-black transition-all hover:bg-[#00D26A] hover:shadow-[0_0_12px_rgba(0,255,136,0.3)] disabled:opacity-50"
          >
            {submitting ? "Please wait…" : "Sign in"}
          </button>
        </form>

        <div className="mt-4 flex items-center gap-2">
          <div className="h-px flex-1 bg-[#2A2A2A]" />
          <span className="text-[10px] text-[#6B6B6B] uppercase">or</span>
          <div className="h-px flex-1 bg-[#2A2A2A]" />
        </div>

        <button
          onClick={() => void handleGoogleSignIn()}
          disabled={googleLoading || submitting}
          className="mt-3 w-full rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] py-2 text-sm text-[#F5F5F5] hover:bg-[#252525] transition-all disabled:opacity-50"
        >
          {googleLoading ? "Connecting…" : "Continue with Google"}
        </button>

        <button
          onClick={handleWebAuthFallback}
          type="button"
          className="mt-2 w-full rounded-[4px] border border-[#00FF88]/30 bg-[#00FF88]/5 py-1.5 text-xs text-[#00FF88] hover:bg-[#00FF88]/10 transition-all"
        >
          Sign in via Web Browser Tab ↗
        </button>

        <p className="mt-4 text-center text-[10px] text-[#6B6B6B]">
          Don&apos;t have an account?{" "}
          <a
            href={`${WEBAPP_URL}/auth?mode=signup`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#00FF88] hover:underline"
          >
            Sign up on the web
          </a>
        </p>
      </div>
    </div>
  );
}
