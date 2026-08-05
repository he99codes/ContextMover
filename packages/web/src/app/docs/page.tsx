/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import Link from "next/link";
import { BookOpen, ChevronRight, Star, Layers, Brain, Cloud, Download, Chrome, Users, Zap } from "lucide-react";

export const metadata = { title: "How to Use ContextMover — Full Guide" };

// ── Section anchor helper ─────────────────────────────────────────────────────

function Anchor({ id }: { id: string }) {
  return <span id={id} className="block relative -top-20" aria-hidden />;
}

// ── Image placeholder ─────────────────────────────────────────────────────────

function ImgPlaceholder({ label, height = 220 }: { label: string; height?: number }) {
  return (
    <div
      className="w-full rounded-[10px] border border-dashed border-[#2A2A2A] bg-[#0F0F0F] flex flex-col items-center justify-center gap-2 text-[#3A3A3A] my-4"
      style={{ height }}
    >
      <div className="w-8 h-8 rounded-full border border-[#2A2A2A] flex items-center justify-center">
        <span className="text-xs">IMG</span>
      </div>
      <span className="text-xs font-mono">{label}</span>
    </div>
  );
}

// ── Callout box ───────────────────────────────────────────────────────────────

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[8px] border border-[#00FF88]/20 bg-[#00FF88]/5 px-4 py-3 text-sm text-[#B0FFDB] leading-relaxed my-4">
      {children}
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[8px] border border-white/20 bg-white/5 px-4 py-3 text-sm text-gray-300 leading-relaxed my-4">
      {children}
    </div>
  );
}

// ── Step row ──────────────────────────────────────────────────────────────────

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 mt-6">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[#00FF88]/10 border border-[#00FF88]/30 flex items-center justify-center text-xs font-bold text-[#00FF88] mt-0.5">
        {n}
      </div>
      <div className="flex-1">
        <p className="text-sm font-semibold text-[#F5F5F5] mb-1">{title}</p>
        <div className="text-sm text-[#8B8B8B] leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

// ── Section heading ───────────────────────────────────────────────────────────

function Section({ id, icon: Icon, title, subtitle, children }: {
  id: string;
  icon: React.ElementType;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-16">
      <Anchor id={id} />
      <div className="flex items-center gap-3 mb-2">
        <Icon size={18} className="text-[#00FF88] flex-shrink-0" />
        <h2 className="text-xl font-bold text-[#F5F5F5]">{title}</h2>
      </div>
      <p className="text-sm text-[#6B6B6B] mb-6">{subtitle}</p>
      {children}
    </section>
  );
}

// ── Table of contents item ────────────────────────────────────────────────────

function TocItem({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="flex items-center gap-1.5 text-xs text-[#6B6B6B] hover:text-[#00FF88] transition-colors">
      <ChevronRight size={12} />
      {label}
    </a>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5]">
      <div className="max-w-3xl mx-auto px-6 py-16">

        {/* Breadcrumb */}
        <div className="mb-6">
          <Link href="/" className="text-xs font-mono text-[#6B6B6B] hover:text-[#00FF88] transition-colors">
            ← ContextMover
          </Link>
        </div>

        {/* Hero */}
        <div className="flex items-center gap-3 mb-3">
          <BookOpen size={22} className="text-[#00FF88]" />
          <h1 className="text-3xl font-black text-[#F5F5F5]">How to Use ContextMover</h1>
        </div>
        <p className="text-sm text-[#6B6B6B] mb-10 max-w-xl">
          Complete guide to capturing conversations, migrating context across AI platforms,
          setting up your Pro subscription, and building a centralized memory layer across devices.
        </p>

        {/* TOC */}
        <div className="rounded-[10px] border border-[#1E1E1E] bg-[#0F0F0F] p-5 mb-14">
          <p className="text-xs font-mono text-[#4B4B4B] mb-3 uppercase tracking-wider">On this page</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <TocItem href="#quick-start"     label="Quick Start" />
            <TocItem href="#pro-setup"       label="Pro Subscription Setup" />
            <TocItem href="#central-memory"  label="Centralized Memory Layer" />
            <TocItem href="#tier1"           label="Tier 1 — Full Context Migration" />
            <TocItem href="#tier2"           label="Tier 2 — Smart Summary Migration" />
            <TocItem href="#tier3"           label="Tier 3 — Attention Engine Migration" />
            <TocItem href="#download"        label="Downloading Session Files" />
            <TocItem href="#drive"           label="Google Drive Connection" />
          </div>
        </div>

        {/* ── 1. Quick Start ──────────────────────────────────────────────── */}
        <Section id="quick-start" icon={Zap} title="Quick Start" subtitle="Get capturing in under two minutes.">
          <Step n={1} title="Install the Chrome extension">
            Visit the Chrome Web Store, search for <strong className="text-[#F5F5F5]">ContextMover</strong>, and click
            <span className="ml-1 px-1.5 py-0.5 rounded bg-[#1A1A1A] font-mono text-xs text-[#00FF88]">Add to Chrome</span>.
          </Step>
          <Step n={2} title="Open any supported AI platform">
            Go to Claude, ChatGPT, Gemini, Grok, Perplexity, or DeepSeek and have a conversation. ContextMover
            captures your session automatically — there is no setup required and nothing extra to click.
          </Step>
          <Step n={3} title="Open the sidebar">
            Click the ContextMover icon in your Chrome toolbar (or press the keyboard shortcut shown in the extension popup).
            Your captured sessions appear in the list on the left.
          </Step>
          <Step n={4} title="Migrate to another platform">
            Select a session, pick a target platform, choose a migration tier (see Tiers below), and click
            <span className="ml-1 px-1.5 py-0.5 rounded bg-[#1A1A1A] font-mono text-xs text-[#00FF88]">Migrate</span>.
            Your context appears in the target AI&apos;s input field, ready to continue.
          </Step>
          <ImgPlaceholder label="screenshot — sidebar session list + migrate button" />
        </Section>

        {/* ── 2. Pro Subscription ─────────────────────────────────────────── */}
        <Section id="pro-setup" icon={Star} title="Pro Subscription Setup" subtitle="Unlock unlimited migration, Attention Engine (Tier 3), and multi-seat access.">
          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">Getting Pro</h3>
          <Step n={1} title="Go to contextmover.com and sign in">
            Use the Google account that you want to be your <strong className="text-[#F5F5F5]">master account</strong>.
            This email becomes the license holder — write it down.
          </Step>
          <Step n={2} title="Choose a plan and complete payment">
            Select Monthly or Yearly. Payment is processed through Stripe (card) or Razorpay (UPI/cards for India).
            After payment you receive a confirmation email and your account upgrades immediately.
          </Step>
          <Step n={3} title="Sign in to the extension with the same Google account">
            Open the ContextMover sidebar → Settings → Sign in with Google.
            Use the <strong className="text-[#F5F5F5]">exact same email</strong> you paid with. The extension validates
            your seat against the subscription database on sign-in.
          </Step>
          <ImgPlaceholder label="screenshot — Settings → Sign in with Google" />

          <Note>
            <strong>One seat = one Chrome profile.</strong> The Pro license is tied to your Google account email.
            If you sign in with a different Gmail on the extension, it will not inherit the Pro seat unless that email
            is added as an authorized seat (see Centralized Memory Layer below).
          </Note>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mt-8 mb-3">What Pro Unlocks</h3>
          <ul className="space-y-2 text-sm text-[#8B8B8B]">
            {[
              "Unlimited session migrations per day (Free tier is capped)",
              "Tier 3 — Attention Engine: on-device semantic AI for the highest-quality summaries",
              "Google Drive sync: sessions backed up to your own Drive automatically",
              "Personal Vault: encrypted sync to your own Supabase project",
              "Authorized sub-seats: share your Pro plan across multiple Chrome profiles / devices",
              "Priority background indexing: your sessions are indexed first",
            ].map(f => (
              <li key={f} className="flex gap-2">
                <span className="text-[#00FF88] mt-0.5 flex-shrink-0">✓</span>
                {f}
              </li>
            ))}
          </ul>
        </Section>

        {/* ── 3. Centralized Memory Layer ─────────────────────────────────── */}
        <Section
          id="central-memory"
          icon={Users}
          title="Centralized Memory Layer"
          subtitle="Link multiple Chrome accounts and devices to one Pro master — a single brain for all your AI conversations."
        >
          <p className="text-sm text-[#8B8B8B] leading-relaxed mb-6">
            ContextMover&apos;s multi-seat architecture lets you sign in to the extension across as many Chrome
            profiles or devices as you own and treat them all as one unified memory. Your work laptop, home desktop,
            and secondary browser profile all share the same session library via Google Drive.
          </p>

          <div className="rounded-[10px] border border-[#1E1E1E] bg-[#0F0F0F] p-5 mb-6">
            <p className="text-xs font-mono text-[#4B4B4B] mb-3 uppercase tracking-wider">Architecture</p>
            <div className="space-y-2 text-sm">
              <div className="flex items-start gap-3">
                <span className="text-[#00FF88] font-bold mt-0.5 flex-shrink-0">Master</span>
                <span className="text-[#8B8B8B]">
                  The Google account you paid with. Owns the Pro license. Authorizes sub-accounts.
                  Google Drive appdata is attached to this account — all sub-seats sync here.
                </span>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-[#6B6B6B] font-bold mt-0.5 flex-shrink-0">Sub-seat</span>
                <span className="text-[#8B8B8B]">
                  Any Google account you add to the Pro Seats list. Inherits Pro features.
                  Syncs sessions to the master account&apos;s Drive folder.
                </span>
              </div>
            </div>
          </div>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">Adding an Authorized Sub-Seat</h3>
          <Step n={1} title="Open the web dashboard">
            Go to <span className="font-mono text-[#00FF88]">contextmover.com/account</span> and sign in with your
            master account.
          </Step>
          <Step n={2} title="Navigate to Pro Seats">
            Click <strong className="text-[#F5F5F5]">Manage Seats</strong> in the sidebar. You will see a list of
            currently authorized emails.
          </Step>
          <Step n={3} title="Add the sub-account email">
            Enter the Gmail address of the Chrome profile you want to authorize, then click
            <span className="ml-1 px-1.5 py-0.5 rounded bg-[#1A1A1A] font-mono text-xs text-[#00FF88]">Add Seat</span>.
            The sub-account is now recognized as a Pro user.
          </Step>
          <Step n={4} title="Sign in to the extension on the second device / profile">
            Open ContextMover on the second Chrome profile. Sign in with the sub-account email (Settings → Sign in
            with Google). The extension recognizes the seat and unlocks Pro features.
          </Step>
          <Step n={5} title="Connect both profiles to the same Google Drive">
            In each profile, open Settings → Google Drive → Connect. Sign in with the <strong className="text-[#F5F5F5]">master
            account</strong> (not the sub-account). Both profiles now read and write to the same Drive appdata folder —
            sessions captured on device A appear on device B automatically.
          </Step>
          <ImgPlaceholder label="screenshot — Manage Seats page with authorized emails" />

          <Note>
            Connect Drive with the <strong>master account email</strong> on every device, regardless of which
            Google account the Chrome profile uses for extension sign-in. This ensures all devices write to the same
            Drive folder and sync remains consistent.
          </Note>

          <Warn>
            Sub-account emails must be explicitly listed under your master account&apos;s Pro Seats. An email that is
            not listed does not inherit Pro — even if that person knows your password. Remove seats for accounts you
            no longer want to authorize.
          </Warn>
        </Section>

        {/* ── 4. Tier 1 ───────────────────────────────────────────────────── */}
        <Section
          id="tier1"
          icon={Layers}
          title="Tier 1 — Full Context Migration"
          subtitle="Verbatim. Every word of your conversation, injected as-is. Best for short-to-medium sessions."
        >
          <div className="grid grid-cols-3 gap-3 mb-6 text-center">
            {[
              { label: "Speed", value: "Instant", color: "text-[#00FF88]" },
              { label: "Quality", value: "Perfect", color: "text-[#00FF88]" },
              { label: "Session size", value: "≤ ~20k tokens", color: "text-gray-300" },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-[8px] border border-[#1E1E1E] bg-[#0F0F0F] p-3">
                <p className={`text-sm font-semibold ${color}`}>{value}</p>
                <p className="text-xs text-[#4B4B4B] mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          <p className="text-sm text-[#8B8B8B] leading-relaxed mb-4">
            Tier 1 copies every single message from the captured session into the target platform&apos;s
            input, preserving the full conversation verbatim. No summarization or compression is applied.
            This is the fastest option and gives the target AI complete context — but it consumes the
            target model&apos;s context window proportionally.
          </p>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">When to use Tier 1</h3>
          <ul className="space-y-1.5 text-sm text-[#8B8B8B] mb-4">
            <li className="flex gap-2"><span className="text-[#00FF88] flex-shrink-0">→</span> Short debugging sessions (under 30 messages)</li>
            <li className="flex gap-2"><span className="text-[#00FF88] flex-shrink-0">→</span> Sessions where exact phrasing matters (legal, medical, code reviews)</li>
            <li className="flex gap-2"><span className="text-[#00FF88] flex-shrink-0">→</span> You want to pick up exactly where you left off with zero loss</li>
          </ul>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">How to run a Tier 1 migration</h3>
          <Step n={1} title="Open the ContextMover sidebar">Select the session you want to migrate from the session list.</Step>
          <Step n={2} title="Click Migrate">A panel opens. Under Intelligence Tier select <strong className="text-[#F5F5F5]">Full Context (T1)</strong>.</Step>
          <Step n={3} title="Pick the target platform">Choose Claude, ChatGPT, Gemini, Grok, Perplexity, or DeepSeek from the dropdown.</Step>
          <Step n={4} title="Click Migrate">
            The extension opens (or focuses) a new tab on the target platform and injects
            your full conversation into the input field. Press Enter or Submit on the target platform to continue.
          </Step>
          <ImgPlaceholder label="screenshot — migration modal with Tier 1 selected" />
        </Section>

        {/* ── 5. Tier 2 ───────────────────────────────────────────────────── */}
        <Section
          id="tier2"
          icon={Layers}
          title="Tier 2 — Smart Summary Migration"
          subtitle="Regex-scored extraction. Pulls goals, decisions, and code snippets — discards filler. Best for medium-to-large sessions."
        >
          <div className="grid grid-cols-3 gap-3 mb-6 text-center">
            {[
              { label: "Speed", value: "~1–3 s", color: "text-[#00FF88]" },
              { label: "Compression", value: "60–80%", color: "text-[#00FF88]" },
              { label: "Session size", value: "Any", color: "text-[#00FF88]" },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-[8px] border border-[#1E1E1E] bg-[#0F0F0F] p-3">
                <p className={`text-sm font-semibold ${color}`}>{value}</p>
                <p className="text-xs text-[#4B4B4B] mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          <p className="text-sm text-[#8B8B8B] leading-relaxed mb-4">
            Tier 2 runs a fast heuristic extraction pass over your session. It scores each message for
            importance using regex patterns that detect goals, questions, decisions, code blocks, and
            error messages. Low-signal messages (acknowledgements, filler) are dropped. The result is a
            dense summary that fits comfortably in the target model&apos;s context window while preserving
            all meaningful content.
          </p>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">When to use Tier 2</h3>
          <ul className="space-y-1.5 text-sm text-[#8B8B8B] mb-4">
            <li className="flex gap-2"><span className="text-[#00FF88] flex-shrink-0">→</span> Long brainstorming or planning sessions you need to continue quickly</li>
            <li className="flex gap-2"><span className="text-[#00FF88] flex-shrink-0">→</span> Sessions that exceed the target model&apos;s context window at full verbatim</li>
            <li className="flex gap-2"><span className="text-[#00FF88] flex-shrink-0">→</span> You want most context preserved but can tolerate minor rephrasing</li>
          </ul>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">How to run a Tier 2 migration</h3>
          <Step n={1} title="Open the sidebar and select a session">Any session works — Tier 2 handles sessions of any length.</Step>
          <Step n={2} title="Click Migrate → Smart Summary (T2)">The tier selector will show an estimated token count before and after compression.</Step>
          <Step n={3} title="Pick the target platform and click Migrate">
            The summary is computed client-side in ~1–3 seconds, then injected into the target tab.
            No data leaves your device during summarization.
          </Step>
          <ImgPlaceholder label="screenshot — Tier 2 selected, showing estimated compression ratio" />

          <Note>
            Tier 2 is the recommended default for most migrations. It balances speed, quality, and token
            efficiency. Upgrade to Tier 3 only when you need semantic precision over keyword matching.
          </Note>
        </Section>

        {/* ── 6. Tier 3 ───────────────────────────────────────────────────── */}
        <Section
          id="tier3"
          icon={Brain}
          title="Tier 3 — Attention Engine Migration"
          subtitle="On-device semantic AI (MiniLM-L6-v2 ONNX). Understands meaning, not just keywords. Pro only."
        >
          <div className="grid grid-cols-3 gap-3 mb-6 text-center">
            {[
              { label: "Speed (modern CPU)", value: "~8–25 s", color: "text-gray-300" },
              { label: "Speed (older i3/i5)", value: "~40–120 s", color: "text-gray-400" },
              { label: "Quality", value: "Highest", color: "text-[#00FF88]" },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded-[8px] border border-[#1E1E1E] bg-[#0F0F0F] p-3">
                <p className={`text-sm font-semibold ${color}`}>{value}</p>
                <p className="text-xs text-[#4B4B4B] mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          <p className="text-sm text-[#8B8B8B] leading-relaxed mb-4">
            Tier 3 runs a real neural embedding model — <span className="font-mono text-[#CCC]">Xenova/all-MiniLM-L6-v2</span> —
            entirely on your device using WASM ONNX. It converts every chunk of your session into a 384-dimensional
            semantic vector, then uses an attention scoring algorithm to identify which parts of the conversation
            are semantically most important. The output is a dense, high-fidelity summary that preserves nuance
            that keyword extraction misses.
          </p>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">How Tier 3 works under the hood</h3>
          <div className="space-y-2 text-sm text-[#8B8B8B] mb-4 pl-3 border-l border-[#2A2A2A]">
            <p><span className="text-[#F5F5F5] font-medium">1. Background indexing:</span> As soon as you capture a session, ContextMover begins chunking and embedding it in a background worker. This happens continuously at low priority so your browser stays fast.</p>
            <p><span className="text-[#F5F5F5] font-medium">2. Migration takes priority:</span> When you start a T3 migration, background indexing is paused and all ONNX compute is dedicated to your migration job. Other sessions resume indexing after migration completes.</p>
            <p><span className="text-[#F5F5F5] font-medium">3. Attention scoring:</span> The engine scores each chunk using cosine similarity and positional weighting to compute an importance map across the conversation.</p>
            <p><span className="text-[#F5F5F5] font-medium">4. Injection:</span> Top-scoring chunks are formatted for the target platform (XML for Claude, Markdown for ChatGPT, plain text for Gemini) and injected.</p>
          </div>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">When to use Tier 3</h3>
          <ul className="space-y-1.5 text-sm text-[#8B8B8B] mb-4">
            <li className="flex gap-2"><span className="text-[#00FF88] flex-shrink-0">→</span> Very long sessions where Tier 2 loses important nuance</li>
            <li className="flex gap-2"><span className="text-[#00FF88] flex-shrink-0">→</span> Research, analysis, or multi-step reasoning sessions</li>
            <li className="flex gap-2"><span className="text-[#00FF88] flex-shrink-0">→</span> You have a modern CPU (2020+) and 1–2 minutes to spare</li>
          </ul>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">How to run a Tier 3 migration</h3>
          <Step n={1} title="Ensure the session is indexed">
            Open the sidebar. Sessions that have been indexed show a semantic search icon. If your session has no
            index yet, wait for background indexing to complete or select the session and let T3 index it during migration.
          </Step>
          <Step n={2} title="Click Migrate → Attention Engine (T3)">You may see a tier-confirmation dialog explaining the expected wait time based on session length.</Step>
          <Step n={3} title="Confirm and wait">
            A progress indicator appears. On a modern CPU (Intel 12th gen / Ryzen 5000+) expect 8–25 seconds.
            On older hardware (i3 4th gen) expect 40–120 seconds. Your browser remains usable during this time.
          </Step>
          <Step n={4} title="Review the quality score">
            After injection, ContextMover shows a quality score (0–100) indicating how much semantic coverage
            was preserved. A score above 75 is excellent.
          </Step>
          <ImgPlaceholder label="screenshot — T3 progress indicator + quality score after migration" />

          <Warn>
            Tier 3 requires a Pro subscription. On very old hardware (pre-2015 CPUs without SIMD AVX2 support)
            ONNX may be slow — consider using Tier 2 for day-to-day use and reserving T3 for your highest-priority sessions.
          </Warn>
        </Section>

        {/* ── 7. Downloading sessions ─────────────────────────────────────── */}
        <Section
          id="download"
          icon={Download}
          title="Downloading Session Files"
          subtitle="Export any captured session as a JSON or Markdown file for archiving or offline use."
        >
          <p className="text-sm text-[#8B8B8B] leading-relaxed mb-4">
            Every session ContextMover captures is stored locally in IndexedDB. You can export any session at any
            time — no internet connection required.
          </p>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">Exporting a session</h3>
          <Step n={1} title="Open the sidebar and find the session">Use the search bar or scroll the session list to locate the conversation you want.</Step>
          <Step n={2} title="Open the session detail view">Click on the session name to open the transcript viewer.</Step>
          <Step n={3} title="Click the Download icon">
            In the top-right of the transcript viewer, click the download icon. A dropdown lets you choose:
            <ul className="mt-2 space-y-1 pl-3">
              <li><span className="font-mono text-xs text-[#00FF88]">JSON</span> — complete session data including metadata, timestamps, and all messages. Use for re-importing or programmatic access.</li>
              <li><span className="font-mono text-xs text-[#00FF88]">Markdown</span> — human-readable transcript. Use for documentation, sharing, or pasting into Notion/Obsidian.</li>
            </ul>
          </Step>
          <Step n={4} title="Save the file">Your browser&apos;s standard Save dialog opens. Choose a location. Done.</Step>
          <ImgPlaceholder label="screenshot — transcript viewer with download dropdown open" />

          <Note>
            JSON exports include the full <code className="font-mono text-xs">messages</code> array and session metadata.
            You can re-import a JSON export in a future version of ContextMover (import feature coming soon).
          </Note>
        </Section>

        {/* ── 8. Google Drive ─────────────────────────────────────────────── */}
        <Section
          id="drive"
          icon={Cloud}
          title="Google Drive Connection"
          subtitle="Automatic bidirectional backup of all your sessions. Survives browser wipes, new devices, and re-installs."
        >
          <p className="text-sm text-[#8B8B8B] leading-relaxed mb-4">
            ContextMover stores backups in Google Drive&apos;s <em>appdata</em> folder — a private, hidden area only
            your ContextMover extension can read. No one else (not even Google, through the Drive UI) can browse
            this folder. Sessions sync automatically in the background after every capture.
          </p>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">Which Google account to use for Drive</h3>

          <div className="rounded-[10px] border border-[#00FF88]/20 bg-[#00FF88]/5 px-5 py-4 mb-5">
            <p className="text-sm font-bold text-[#00FF88] mb-1">Always connect Drive with your master account email.</p>
            <p className="text-sm text-[#B0FFDB] leading-relaxed">
              This is the Gmail you used to purchase the Pro subscription — not a sub-account. Every device and
              Chrome profile (including sub-seat profiles) should authorize Drive with the master account. This
              ensures all sessions converge into one Drive folder and sync across all your devices seamlessly.
            </p>
          </div>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mb-3">Connecting Google Drive</h3>
          <Step n={1} title="Open ContextMover Settings">Click the settings icon in the sidebar footer (gear icon).</Step>
          <Step n={2} title="Find the Google Drive section">Scroll to <strong className="text-[#F5F5F5]">Cloud Sync → Google Drive</strong>. You will see a Connect button.</Step>
          <Step n={3} title="Click Connect and sign in">
            A Google OAuth popup opens. <strong className="text-[#F5F5F5]">Select your master account email</strong> (the one on
            your Pro subscription). Grant the requested Drive appdata permission. Do not select a sub-account here.
          </Step>
          <Step n={4} title="Wait for initial sync">
            The first sync uploads all locally captured sessions to Drive. Depending on how many sessions you have,
            this may take 10–60 seconds. A spinner in the sidebar header shows sync status.
          </Step>
          <Step n={5} title="Repeat on every device / Chrome profile">
            On each additional device or profile where you use ContextMover, follow the same steps and authorize
            Drive with the <strong className="text-[#F5F5F5]">same master account email</strong>. Within minutes,
            sessions from all devices will appear in every profile.
          </Step>
          <ImgPlaceholder label="screenshot — Settings → Google Drive → Connect with master account selected" />
          <ImgPlaceholder label="screenshot — Drive sync status indicator in sidebar header" height={140} />

          <Warn>
            <strong>Do not connect Drive with a sub-account email.</strong> If each device uses a different Drive
            account, sessions will not merge and you will have multiple isolated libraries instead of one
            unified memory layer.
          </Warn>

          <h3 className="text-sm font-semibold text-[#F5F5F5] mt-6 mb-3">Disconnecting Drive</h3>
          <p className="text-sm text-[#8B8B8B] leading-relaxed">
            Go to Settings → Google Drive → Disconnect. This revokes the extension&apos;s OAuth token and stops future
            syncs. Your Drive appdata folder is retained (nothing is deleted from Drive). You can reconnect at any
            time.
          </p>
        </Section>

        {/* ── Cross-device setup recap ─────────────────────────────────────── */}
        <div className="rounded-[10px] border border-[#1E1E1E] bg-[#0F0F0F] p-6 mb-16">
          <div className="flex items-center gap-2 mb-4">
            <Chrome size={16} className="text-[#00FF88]" />
            <p className="text-sm font-semibold text-[#F5F5F5]">Complete multi-device setup checklist</p>
          </div>
          <div className="space-y-2">
            {[
              "Purchase Pro on contextmover.com using your master Google account",
              "Add sub-account emails in the Pro Seats manager on the web dashboard",
              "Install ContextMover on every Chrome profile / device",
              "Sign in to extension with the profile's own Google account (master or sub)",
              "Connect Google Drive on every profile using the master account email",
              "Verify sessions from all devices appear in all profiles within ~60 seconds",
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-3 text-sm text-[#8B8B8B]">
                <span className="flex-shrink-0 w-5 h-5 rounded border border-[#2A2A2A] flex items-center justify-center text-xs text-[#4B4B4B] mt-0.5">{i + 1}</span>
                {item}
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row gap-4">
          <a
            href="mailto:hey@contextmover.com"
            className="flex items-center justify-center gap-2 rounded-[8px] border border-[#2A2A2A] px-5 py-3 text-sm text-[#6B6B6B] hover:border-[#3A3A3A] hover:text-[#F5F5F5] transition-all"
          >
            Contact support
          </a>
          <Link
            href="/"
            className="flex items-center justify-center gap-2 rounded-[8px] border border-[#2A2A2A] px-5 py-3 text-sm text-[#6B6B6B] hover:border-[#3A3A3A] hover:text-[#F5F5F5] transition-all"
          >
            ← Back to home
          </Link>
        </div>

      </div>
    </div>
  );
}
