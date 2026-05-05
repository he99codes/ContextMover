import Link from "next/link";
import { Shield, Lock, Database, Server, Check } from "lucide-react";

export const metadata = { title: "Privacy Policy — ContextForge" };

const LAST_UPDATED = "January 2025";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5]">
      <div className="max-w-3xl mx-auto px-6 py-16">
        {/* Header */}
        <div className="mb-12">
          <Link href="/" className="text-xs font-mono text-[#6B6B6B] hover:text-[#00FF88] transition-colors">
            ← ContextForge
          </Link>
          <h1 className="mt-6 text-3xl font-black uppercase text-[#00FF88]" style={{ letterSpacing: "0.12em" }}>
            Privacy Policy
          </h1>
          <p className="mt-2 text-sm text-[#6B6B6B]">Last updated: {LAST_UPDATED}</p>
        </div>

        {/* Zero Knowledge Banner */}
        <div className="mb-12 rounded-[10px] border border-[#00FF88]/20 bg-[#00FF88]/5 p-6">
          <div className="flex items-center gap-3 mb-4">
            <Shield size={20} className="text-[#00FF88]" />
            <h2 className="text-lg font-black uppercase tracking-wider text-[#00FF88]">Zero-Knowledge Architecture</h2>
          </div>
          <p className="text-sm text-[#B0B0B0] leading-relaxed mb-4">
            ContextForge operates on a <strong className="text-[#F5F5F5]">zero-knowledge privacy model</strong> for your conversation data. Your AI conversations are captured and stored exclusively in your browser extension's local IndexedDB. They never travel through ContextForge servers.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { icon: Lock,     text: "Conversation content never stored on ContextForge servers" },
              { icon: Database, text: "Optional sync to YOUR personal Supabase — ContextForge has zero access" },
              { icon: Server,   text: "AES-256-GCM encrypted vault credentials, keys never leave your device" },
              { icon: Check,    text: "You own all your data — export or delete at any time" },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-start gap-2.5">
                <Icon size={13} className="mt-0.5 shrink-0 text-[#00FF88]" />
                <p className="text-xs text-[#6B6B6B] leading-relaxed">{text}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Sections */}
        <div className="space-y-10 text-sm text-[#B0B0B0] leading-relaxed">

          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">1. What We Collect — and What We Don't</h2>
            <p className="mb-4">ContextForge is built on the principle of minimal data collection. Here is a precise breakdown:</p>

            <div className="rounded-[8px] border border-[#2A2A2A] bg-[#111] overflow-hidden mb-4">
              <div className="border-b border-[#2A2A2A] px-4 py-2.5 text-xs font-semibold text-[#00FF88] uppercase tracking-widest">Data stored on ContextForge servers</div>
              <div className="divide-y divide-[#1A1A1A]">
                {[
                  ["Authentication credentials", "Email, hashed password (managed by Supabase Auth)"],
                  ["Subscription status", "Plan tier, payment status only — no payment card data"],
                  ["Prompt marketplace templates", "Public, opt-in templates you choose to share"],
                  ["Prompt assignments", "Which template is assigned to which platform — no conversation content"],
                  ["Anonymous analytics", "Aggregate feature usage, no personally identifiable information"],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-4 px-4 py-2.5">
                    <span className="w-48 shrink-0 text-xs text-[#F5F5F5]">{k}</span>
                    <span className="text-xs text-[#6B6B6B]">{v}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[8px] border border-red-500/20 bg-red-500/4 overflow-hidden">
              <div className="border-b border-red-500/15 px-4 py-2.5 text-xs font-semibold text-red-400 uppercase tracking-widest">Data that NEVER touches ContextForge servers</div>
              <div className="divide-y divide-[#1A1A1A]">
                {[
                  "The content of your AI conversations (prompts and responses)",
                  "Your conversation titles and metadata",
                  "Timestamps and turn counts of captured sessions",
                  "Any personal Supabase vault credentials",
                  "IDE snapshots, git diffs, or code context",
                ].map((item) => (
                  <div key={item} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="h-1 w-1 rounded-full bg-red-500/60 shrink-0" />
                    <span className="text-xs text-[#6B6B6B]">{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">2. Local Storage and the Browser Extension</h2>
            <p>When you install the ContextForge browser extension, your AI conversations are captured and stored in your browser's IndexedDB — a local database accessible only to the extension on your own machine. This data never leaves your device unless you explicitly connect a personal Supabase vault.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">3. Personal Vault (Optional)</h2>
            <p className="mb-3">If you choose to connect your own Supabase project as a "personal vault," your session data syncs to your Supabase project — not ContextForge's. The vault URL and anon key are stored with AES-256-GCM encryption in your local browser storage, with the decryption key derived from your account credentials via PBKDF2. The encrypted credentials are never transmitted to ContextForge servers.</p>
            <p>You may disconnect or delete your vault data at any time from Settings → Personal Vault. Disconnecting does not delete local or vault data — you retain full control.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">4. Cookies and Authentication</h2>
            <p>We use Supabase Auth to manage user accounts. Authentication state is stored in cookies and localStorage strictly for session management. We do not use tracking cookies, advertising pixels, or third-party analytics.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">5. Data Sharing</h2>
            <p>We do not sell, rent, or share your personal information with third parties, except: (a) Supabase Inc., our database and authentication provider; (b) Stripe, our payment processor, for subscription billing only; (c) as required by applicable law.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">6. Your Rights</h2>
            <p className="mb-3">You have the right to access, export, correct, or delete any personal data we hold about you. To exercise these rights, contact us at <a href="mailto:privacy@contextforge.app" className="text-[#00FF88] hover:underline">privacy@contextforge.app</a>.</p>
            <p>Because your AI conversation data is stored locally and/or in your personal vault, ContextForge cannot access it — requests for conversation data must be handled directly by you in your browser extension or Supabase dashboard.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">7. Security</h2>
            <p>We employ industry-standard security measures including TLS in transit, encrypted database storage (Supabase), and AES-256-GCM for vault credential encryption. Our zero-knowledge architecture means that even in the event of a ContextForge server breach, your conversation content cannot be compromised because it was never there.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">8. Changes to This Policy</h2>
            <p>We will post any changes to this policy on this page with an updated date. Continued use of ContextForge after changes constitutes acceptance of the revised policy. For material changes, we will notify you via email.</p>
          </section>

          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">9. Contact</h2>
            <p>Questions about this policy? <a href="mailto:privacy@contextforge.app" className="text-[#00FF88] hover:underline">privacy@contextforge.app</a></p>
          </section>

        </div>
      </div>
    </div>
  );
}
