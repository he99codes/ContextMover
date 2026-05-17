"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { Check, Mail } from "lucide-react";
import { CHROME_STORE_URL } from "@/config/urls";
import BuildWithMe from "@/components/BuildWithMe";
import EmailWidget from "@/components/EmailWidget";

// ─── Scroll-reveal hook ───────────────────────────────────────────────────────

function useScrollReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) e.target.classList.add("is-visible"); }),
      { threshold: 0.08, rootMargin: "0px 0px -40px 0px" }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

// ─── Sub-components ───────────────────────────────────────────────────────────


function TerminalDemo() {
  const [step, setStep] = useState(0);
  const totalSteps = 14;

  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s + 1) % totalSteps), 600);
    return () => clearInterval(t);
  }, []);

  const captureLines = [
    { role: "user", text: "Help me debug this JWT refresh issue" },
    { role: "ai",   text: "Looking at your middleware — cookie scope is wrong" },
    { role: "user", text: "It still fails on mobile Safari" },
    { role: "ai",   text: "Found it: SameSite=None requires the Secure flag" },
  ];
  const injectLines = [
    { role: "sys",  text: "[Context: 47 msgs · Smart Summary applied]" },
    { role: "user", text: "Continue where we left off" },
    { role: "ai",   text: "Based on your JWT session, the Secure flag fix…" },
    { role: "ai",   text: "Your SameSite cookie issue is now resolved." },
  ];

  const lineStyle = (visible: boolean, dir: "left" | "right") => ({
    opacity: visible ? 1 : 0,
    transform: visible ? "none" : `translateX(${dir === "left" ? "-10px" : "10px"})`,
    transition: "opacity 0.35s ease, transform 0.35s ease",
  });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_72px_1fr] gap-3 max-w-3xl mx-auto text-left">
      {/* Left: Claude */}
      <div className="bg-[#111111] border border-[#2A2A2A] rounded-xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#2A2A2A] bg-[#1A1A1A]">
          <span className="w-2 h-2 rounded-full bg-[#D97706] shrink-0" />
          <span className="text-xs text-[#6B6B6B] font-mono">Captured · Claude</span>
        </div>
        <div className="p-4 font-mono text-xs space-y-2.5 min-h-[148px]">
          {captureLines.map((ln, i) => (
            <div key={i} style={lineStyle(step >= i, "left")}>
              <span className={ln.role === "user" ? "text-[#6B6B6B]" : "text-[#00FF88]"}>
                {ln.role === "user" ? "▶ You: " : "◆ AI:  "}
              </span>
              <span className="text-[#F5F5F5]">{ln.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Middle arrow */}
      <div className="flex flex-row sm:flex-col items-center justify-center gap-1.5 py-2">
        <div style={lineStyle(step >= 4, "left")} className="text-[#00FF88] text-2xl font-bold hidden sm:block">→</div>
        <div style={{ opacity: step >= 5 ? 1 : 0, transition: "opacity 0.4s ease" }} className="text-center">
          <div className="text-[10px] text-[#00FF88] font-semibold leading-tight whitespace-nowrap">▸ Smart</div>
          <div className="text-[10px] text-[#00FF88] font-semibold leading-tight">Summary</div>
        </div>
      </div>

      {/* Right: ChatGPT */}
      <div className="bg-[#111111] border border-[#2A2A2A] rounded-xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#2A2A2A] bg-[#1A1A1A]">
          <span className="w-2 h-2 rounded-full bg-[#10B981] shrink-0" />
          <span className="text-xs text-[#6B6B6B] font-mono">Injected · ChatGPT</span>
        </div>
        <div className="p-4 font-mono text-xs space-y-2.5 min-h-[148px]">
          {injectLines.map((ln, i) => (
            <div key={i} style={lineStyle(step >= i + 6, "right")}>
              <span className={ln.role === "sys" ? "text-[#6B6B6B]" : ln.role === "ai" ? "text-[#10B981]" : "text-[#6B6B6B]"}>
                {ln.role === "sys" ? "◇ sys: " : ln.role === "user" ? "▶ You: " : "◆ AI:  "}
              </span>
              <span className="text-[#F5F5F5]">{ln.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Countdown() {
  const [secs, setSecs] = useState(62_340);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  const h = String(Math.floor(secs / 3600)).padStart(2, "0");
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  return <code className="tabular-nums font-mono">{h}:{m}:{s}</code>;
}

const FAQ_ITEMS = [
  { q: "Is my data safe?",                               a: "Your conversations are stored locally in your browser by default. Cloud sync is optional and goes to YOUR personal Supabase project — not ours. Migration never passes through our servers." },
  { q: "Which AI platforms are supported?",              a: "Claude, ChatGPT, Google Gemini, and xAI Grok for full capture and migration. Perplexity and DeepSeek as migration targets. More platforms coming soon." },
  { q: "Does it work offline?",                          a: "Yes. Core capture and migration works entirely offline. Cloud sync requires internet. Everything else is local-first." },
  { q: "Will it slow down my browser?",                  a: "No. The extension only activates on supported AI platforms. Background processing is minimal and hardware-adaptive — it stays idle when you&apos;re not on an AI platform." },
  { q: "What is the Attention Engine?",                  a: "A local AI model (runs on your device, not our servers) that understands your task semantically and extracts only the most relevant context. Uses WebGPU acceleration when available, falls back to WASM." },
  { q: "Can I delete my data?",                          a: "Yes. Settings \u2192 Danger Zone \u2192 Delete all data. Instant. Permanent. No questions asked and no server-side backups to purge." },
  { q: "Does it work with local AI models like Ollama?",  a: "Not yet. ContextMover currently works with web-based AI platforms. Local model support (Ollama, LM Studio, etc.) is on the roadmap." },
  { q: "What happens when I hit my free tier limit?",    a: "You can still access all your existing sessions. New capture continues. Migrations will prompt you to upgrade for Attention Engine features. Your data is never deleted due to a plan limit." },
  { q: "Can I migrate from DeepSeek to Claude?",         a: "Yes. Select your DeepSeek session in the extension, choose Claude as the target, and click Migrate. DeepSeek is a migration target (you can send context to it), and Claude supports both capture and receiving context." },
];

// ─── Nav dropdown (desktop hover, mobile flat) ────────────────────────────────

function NavDropdown({ label, items }: {
  label: string;
  items: { label: string; desc: string; href: string }[];
}) {
  return (
    <div className="relative group">
      <button
        type="button"
        className="flex items-center gap-1 px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors duration-150 rounded-md hover:bg-[#111]"
      >
        {label}
        <svg className="w-2.5 h-2.5 transition-transform duration-200 group-hover:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-52 invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-all duration-150 pt-1 z-50">
        <div className="bg-[#111] border border-[#2A2A2A] rounded-xl py-2 shadow-[0_8px_32px_rgba(0,0,0,0.5)]">
          {items.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="flex flex-col px-4 py-2.5 hover:bg-[#1A1A1A] transition-colors"
            >
              <span className="text-sm text-[#F5F5F5] font-medium">{item.label}</span>
              <span className="text-xs text-[#6B6B6B] mt-0.5">{item.desc}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function FaqAccordion() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-2 max-w-2xl mx-auto">
      {FAQ_ITEMS.map((item, i) => (
        <div key={i} className="border border-[#2A2A2A] rounded-xl overflow-hidden">
          <button
            onClick={() => setOpen(open === i ? null : i)}
            className="w-full text-left px-6 py-4 flex justify-between items-center hover:bg-[#111111] transition-colors"
          >
            <span className="font-medium text-[#F5F5F5] text-sm">{item.q}</span>
            <span
              className="text-[#6B6B6B] transition-transform duration-200 shrink-0 ml-4 text-xs"
              style={{ transform: open === i ? "rotate(180deg)" : "rotate(0deg)" }}
            >▼</span>
          </button>
          <div
            className="overflow-hidden transition-all duration-300 ease-in-out"
            style={{ maxHeight: open === i ? "180px" : "0px" }}
          >
            <p className="px-6 pt-1 pb-5 text-sm text-[#6B6B6B] leading-relaxed border-t border-[#2A2A2A]">
              {item.a}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Static data ──────────────────────────────────────────────────────────────

const PLATFORMS = [
  { name: "Claude",         sub: "Anthropic",    color: "#D97706", badge: "Capture & Migrate", dot: "bg-[#D97706]" },
  { name: "ChatGPT",        sub: "OpenAI",        color: "#10B981", badge: "Capture & Migrate", dot: "bg-[#10B981]" },
  { name: "Google Gemini",  sub: "Google",        color: "#6366F1", badge: "Capture & Migrate", dot: "bg-[#6366F1]" },
  { name: "xAI Grok",       sub: "xAI",           color: "#F5F5F5", badge: "Capture & Migrate", dot: "bg-[#F5F5F5]" },
  { name: "Perplexity",     sub: "Perplexity AI", color: "#20B2AA", badge: "Migrate target",    dot: "bg-[#20B2AA]" },
  { name: "DeepSeek",       sub: "DeepSeek",      color: "#4C8BF5", badge: "Migrate target",    dot: "bg-[#4C8BF5]" },
];

const STEPS = [
  { icon: "◉", num: "01", title: "Capture", body: "Browse any AI platform. ContextMover silently captures your conversation in the background. Supports Claude, ChatGPT, Gemini, Grok and more — with zero setup." },
  { icon: "◈", num: "02", title: "Compress", body: "Choose your intelligence tier: Full Context, Smart Summary, or the Attention Engine. Your context is optimized entirely on your device — never sent to our servers." },
  { icon: "▶", num: "03", title: "Migrate", body: "One click. Your context is perfectly formatted for the target AI and injected directly into its input field. Continue exactly where you left off, instantly." },
];

// ─── Main component ───────────────────────────────────────────────────────────

export default function LandingPage() {
  useScrollReveal();
  const [menuOpen, setMenuOpen] = useState(false);
  const [indiaMode, setIndiaMode] = useState(false);
  const [annual, setAnnual] = useState(false);

  return (
    <div className="bg-[#0A0A0A] text-[#F5F5F5] font-sans overflow-x-hidden">

      {/* ══════════════════════════ 1. NAVBAR ══════════════════════════ */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-[#1A1A1A] bg-[#0A0A0A]/92 backdrop-blur-md transition-all">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 h-14 flex items-center justify-between">
          {/* Logo */}
          <a href="/" className="flex items-center gap-2.5 shrink-0">
            <Image src="/logo.png" alt="ContextMover" width={56} height={56} priority style={{ height: 32, width: "auto" }} />
            <span className="font-bold text-[#F5F5F5] tracking-tight">ContextMover</span>
          </a>

          {/* Desktop center nav */}
          <div className="hidden md:flex items-center gap-0.5">
            <NavDropdown label="Features" items={[
              { label: "Smart Summary",    desc: "60–80% compression",   href: "#tiers" },
              { label: "Attention Engine", desc: "Semantic AI memory",   href: "#tiers" },
              { label: "Caveman Mode",     desc: "Faster AI responses",  href: "#tiers" },
              { label: "Project Files",    desc: "Local folder context", href: "#project-files" },
              { label: "Personal Vault",   desc: "Your own Supabase",    href: "/settings/vault" },
            ]} />
            <NavDropdown label="Platforms" items={[
              { label: "Claude",     desc: "Capture & Migrate", href: "#platforms" },
              { label: "ChatGPT",    desc: "Capture & Migrate", href: "#platforms" },
              { label: "Gemini",     desc: "Capture & Migrate", href: "#platforms" },
              { label: "Grok",       desc: "Capture & Migrate", href: "#platforms" },
              { label: "Perplexity", desc: "Migrate target",    href: "#platforms" },
              { label: "DeepSeek",   desc: "Migrate target",    href: "#platforms" },
            ]} />
            <a href="/pricing" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[#111]">Pricing</a>
            <a href="/dashboard" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[#111]">Dashboard</a>
            <a href="/docs" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[#111]">Docs</a>
            <a href="/feedback" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[#111]">Feedback</a>
            <a href="/contact" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[#111]">Contact</a>
            <a href="#build-with-me" className="px-3 py-1.5 text-sm text-[#00FF88]/60 hover:text-[#00FF88] transition-colors rounded-md hover:bg-[#111]">Build with me</a>
          </div>

          {/* Desktop right */}
          <div className="hidden md:flex items-center gap-2">
            <a href="/auth" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors">Log in</a>
            <a href="/auth?mode=signup" className="bg-[#00FF88] text-[#0A0A0A] font-semibold text-sm px-4 py-1.5 rounded-md hover:bg-[#00CC6A] transition-colors shadow-[0_0_12px_rgba(0,255,136,0.2)]">Get for free</a>
          </div>

          {/* Mobile hamburger */}
          <button
            className="md:hidden flex items-center justify-center w-11 h-11 text-[#6B6B6B] hover:text-[#F5F5F5] active:opacity-80"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
          >
            <span className="text-2xl leading-none select-none">{menuOpen ? "✕" : "☰"}</span>
          </button>
        </div>

        {/* Mobile full-screen overlay menu */}
        {menuOpen && (
          <div className="md:hidden fixed inset-0 z-[200] bg-[#0A0A0A] flex flex-col" style={{ top: 0 }}>
            {/* Overlay header */}
            <div className="flex items-center justify-between px-5 h-14 border-b border-[#1A1A1A] shrink-0">
              <a href="/" className="flex items-center gap-2.5">
                <span className="font-bold text-[#F5F5F5] tracking-tight">ContextMover</span>
              </a>
              <button
                onClick={() => setMenuOpen(false)}
                className="flex items-center justify-center w-11 h-11 text-[#6B6B6B] hover:text-[#F5F5F5] active:opacity-80"
                aria-label="Close menu"
              >
                <span className="text-2xl leading-none">✕</span>
              </button>
            </div>
            {/* Overlay links */}
            <nav className="flex-1 overflow-y-auto px-5 py-4">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[#3A3A3A] px-3 pb-2">Features</p>
              {([
                ["Smart Summary",    "#tiers"],
                ["Attention Engine", "#tiers"],
                ["Caveman Mode",     "#tiers"],
                ["IDE Connection",   "#project-files"],
                ["Personal Vault",   "/settings/vault"],
              ] as const).map(([f, href]) => (
                <a key={f} href={href} className="flex items-center gap-2 text-[18px] text-[#6B6B6B] min-h-[56px] px-3 border-b border-[#111] active:opacity-70" onClick={() => setMenuOpen(false)}>
                  {f}
                  {f === "IDE Connection" && (
                    <span className="text-[9px] font-black uppercase tracking-widest text-[#3A3A3A] border border-[#2A2A2A] rounded px-1.5 py-0.5">Soon</span>
                  )}
                </a>
              ))}
              <div className="mt-2" />
              {([
                ["Pricing",      "/pricing"],
                ["Dashboard",    "/dashboard"],
                ["Docs",         "/docs"],
                ["Feedback",     "/feedback"],
                ["Contact",      "/contact"],
              ] as const).map(([label, href]) => (
                <a key={label} href={href} className="flex items-center text-[18px] text-[#6B6B6B] min-h-[56px] px-3 border-b border-[#111] active:opacity-70" onClick={() => setMenuOpen(false)}>{label}</a>
              ))}
              <a href="#build-with-me" className="flex items-center text-[18px] text-[#00FF88]/60 min-h-[56px] px-3 active:opacity-70" onClick={() => setMenuOpen(false)}>Build with me</a>
            </nav>
            {/* Overlay CTAs */}
            <div className="shrink-0 px-5 pb-8 pt-4 flex flex-col gap-3 border-t border-[#1A1A1A]">
              <a href="/auth" className="flex items-center justify-center border border-[#2A2A2A] text-[#F5F5F5] font-semibold text-base h-[52px] rounded-lg active:opacity-80" onClick={() => setMenuOpen(false)}>Log in</a>
              <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center bg-[#00FF88] text-[#0A0A0A] font-bold text-base h-[52px] rounded-lg active:scale-95 transition-transform shadow-[0_0_16px_rgba(0,255,136,0.25)]" onClick={() => setMenuOpen(false)}>Add to Chrome — free</a>
            </div>
          </div>
        )}
      </nav>

      {/* ══════════════════════════ 2. HERO ══════════════════════════ */}
      <section className="relative min-h-screen flex flex-col items-center justify-center pt-14 sm:pt-14 px-5 pb-16 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-3xl h-[500px] bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(0,255,136,0.08),transparent)]" />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.012)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.012)_1px,transparent_1px)] bg-[size:52px_52px]" />
          <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-[#0A0A0A] to-transparent" />
        </div>
        <div className="relative z-10 max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-[rgba(0,255,136,0.08)] border border-[rgba(0,255,136,0.25)] rounded-full px-3.5 py-1 text-xs text-[#00FF88] font-medium mb-8 animate-fade-in">
            ✦ &nbsp;Context Operating System for AI
          </div>
          <h1 className="text-[2rem] sm:text-5xl lg:text-6xl xl:text-[4.5rem] font-bold text-[#F5F5F5] leading-[1.1] sm:leading-[1.07] tracking-tight mb-6 animate-slide-up" style={{ animationDelay: "80ms" }}>
            Stop re-explaining<br />
            <span className="text-[#00FF88]">yourself</span> to every AI.
          </h1>
          <p className="text-[15px] sm:text-base lg:text-lg text-[#6B6B6B] max-w-xl mx-auto mb-10 leading-relaxed animate-slide-up" style={{ animationDelay: "180ms" }}>
            ContextMover captures your AI conversations, intelligently compresses them, and migrates your full context to any AI platform&nbsp;— instantly.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-6 animate-slide-up" style={{ animationDelay: "280ms" }}>
            <a
              href={CHROME_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-[#00FF88] text-[#0A0A0A] font-bold px-8 py-3.5 rounded-lg text-base w-full sm:w-auto text-center btn-primary shadow-[0_0_24px_rgba(0,255,136,0.25)] min-h-[52px] flex items-center justify-center active:scale-95 transition-transform"
            >
              Add to Chrome — it&apos;s free
            </a>
            <a href="#how" className="border border-[#2A2A2A] text-[#F5F5F5] px-8 py-3.5 rounded-lg text-base hover:border-[rgba(0,255,136,0.4)] transition-colors w-full sm:w-auto text-center min-h-[52px] flex items-center justify-center">
              See how it works →
            </a>
          </div>
          {/* Social proof */}
          <div className="flex flex-col items-center gap-3 mb-10 animate-fade-in" style={{ animationDelay: "340ms" }}>
            <p className="text-sm text-[#6B6B6B]">The world&apos;s 1st and best attention-oriented migration tool —{" "}<strong className="text-[#F5F5F5]">trusted by developers who treat every token like gold.</strong></p>
            <div className="flex items-center gap-5 opacity-50">
              {["Claude", "ChatGPT", "Gemini", "Grok", "Perplexity", "DeepSeek"].map(p => (
                <span key={p} className="text-xs font-mono text-[#6B6B6B]">{p}</span>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-[#6B6B6B] mb-4 animate-fade-in" style={{ animationDelay: "380ms" }}>
            {["■ Local-first", "▸ Works offline", "◈ 3-tier intelligence", "No account needed"].map((t, i) => (
              <span key={i}>{t}</span>
            ))}
          </div>
          <p className="text-xs font-mono text-[#00FF88]/60 mb-10 animate-fade-in" style={{ animationDelay: "420ms" }}>
            🔒 <strong className="text-[#00FF88]/80">Zero-knowledge</strong> — your data never leaves your machine · vault syncs only to your own Supabase · we cannot read or sell your conversations
          </p>
          <div className="animate-slide-up" style={{ animationDelay: "480ms" }}>
            <TerminalDemo />
          </div>
        </div>
      </section>

      {/* ══════════════════════════ 3. PROBLEM ══════════════════════════ */}
      <section className="bg-[#111111] py-14 sm:py-24 px-5">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="reveal text-3xl sm:text-4xl font-bold text-[#F5F5F5] mb-4">Every AI session starts from zero.</h2>
          <p className="reveal text-[#6B6B6B] mb-14">You&apos;ve been there. You know how frustrating it is.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-5 mb-14">
            {[
              { emoji: "⊘", title: "Context window full", body: "You hit the limit. Start over. Re-explain everything from scratch. Hours of work, reduced to a blank chat." },
              { emoji: "⇄", title: "Wrong model for the job", body: "Started in ChatGPT but Claude is better for this. No way to bring your context along. Pick a model and commit forever." },
              { emoji: "◷", title: "Hours of context lost", body: "Long debugging sessions. Complex architectural decisions. All gone the moment you switch tabs or close the browser." },
            ].map((card, i) => (
              <div key={i} className={`reveal reveal-d${i + 1} card-hover bg-[#1A1A1A] border border-[#2A2A2A] rounded-2xl p-5 sm:p-7 text-left`}>
                <div className="text-3xl mb-4">{card.emoji}</div>
                <h3 className="font-semibold text-[#F5F5F5] mb-2">{card.title}</h3>
                <p className="text-sm text-[#6B6B6B] leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
          <p className="reveal italic text-[#F59E0B] text-sm max-w-md mx-auto">
            &ldquo;Developers spend an average of 23 minutes re-explaining context when switching AI tools.&rdquo;
          </p>
        </div>
      </section>

      {/* ══════════════════════════ 4. SOLUTION ══════════════════════════ */}
      <section className="py-14 sm:py-24 px-5">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="reveal text-3xl sm:text-4xl font-bold text-[#F5F5F5] mb-4">One click. Full context. Any AI.</h2>
          <p className="reveal text-[#6B6B6B] max-w-xl mx-auto mb-14 leading-relaxed">
            ContextMover captures your entire conversation, intelligently extracts what matters, and injects it perfectly formatted into your next AI session.
          </p>
          <div className="reveal border border-[#2A2A2A] rounded-2xl p-8 sm:p-10 bg-[#111111] overflow-hidden relative">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_50%_50%,rgba(0,255,136,0.03),transparent)] pointer-events-none" />
            <div className="relative flex flex-col sm:flex-row items-center justify-between gap-6 max-w-2xl mx-auto">
              {/* Sources */}
              <div className="flex flex-row sm:flex-col gap-3">
                {["Claude", "ChatGPT", "Gemini"].map((p) => (
                  <div key={p} className="px-4 py-2 bg-[#1A1A1A] border border-[#2A2A2A] rounded-lg text-sm font-medium text-[#F5F5F5] w-28 text-center">{p}</div>
                ))}
              </div>
              {/* Flow line left */}
              <div className="hidden sm:flex flex-col gap-4 flex-1 px-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-px w-full flow-line rounded-full opacity-70" style={{ animationDelay: `${i * 0.4}s` }} />
                ))}
              </div>
              {/* Center */}
              <div className="border border-[rgba(0,255,136,0.3)] bg-[#0A0F0A] rounded-2xl px-7 py-5 text-center shrink-0 shadow-[0_0_32px_rgba(0,255,136,0.08)]">
                <div className="text-[#00FF88] font-bold text-base mb-1">▸ ContextMover</div>
                <div className="text-[#6B6B6B] text-xs leading-5">captures<br />compresses<br />migrates</div>
              </div>
              {/* Flow line right */}
              <div className="hidden sm:flex flex-col gap-4 flex-1 px-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-px w-full flow-line rounded-full opacity-70" style={{ animationDelay: `${i * 0.4 + 0.2}s` }} />
                ))}
              </div>
              {/* Targets */}
              <div className="flex flex-row sm:flex-col gap-3">
                {["Claude", "ChatGPT", "Gemini"].map((p) => (
                  <div key={p} className="px-4 py-2 bg-[#1A1A1A] border border-[#2A2A2A] rounded-lg text-sm font-medium text-[#F5F5F5] w-28 text-center">{p}</div>
                ))}
              </div>
            </div>
            <p className="relative text-center text-xs text-[#00FF88] mt-8 font-medium tracking-wide">
              Your device. Our servers never involved.
            </p>
          </div>
        </div>
      </section>

      {/* ══════════════════════════ 5. 3-TIER FEATURES ══════════════════════════ */}
      <section id="tiers" className="bg-[#111111] py-14 sm:py-24 px-5">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="reveal text-3xl sm:text-4xl font-bold text-[#F5F5F5] mb-4">Intelligence that matches your needs.</h2>
          <p className="reveal text-[#6B6B6B] mb-14">Three tiers. Every situation covered.</p>
          <div className="grid grid-cols-1 gap-5">
            {[
              { icon: "□", tier: "Full Context",    badge: null,          speed: "▸▸▸ Instant", desc: "Send the complete conversation verbatim. Every word, every code block, zero compression. When you need absolutely everything." },
              { icon: "◆", tier: "Smart Summary",   badge: "Recommended", speed: "▸▸▸ Fast",    desc: "Automatically extracts goals, key decisions, bugs fixed, and all code blocks. The smart default for most sessions — 60–80% compression." },
              { icon: "▸", tier: "Attention Engine", badge: null,          speed: "▸▸ Smart",    desc: "Semantic AI understands your task and finds exactly what's relevant. GPU-accelerated on your device. Best for 1000+ message sessions." },
            ].map((card, i) => (
              <a
                key={i}
                href="#pricing"
                className={`reveal reveal-d${i + 1} relative card-hover bg-[#1A1A1A] border-l-2 border border-[#2A2A2A] border-l-[#00FF88] rounded-2xl p-7 text-left flex flex-col gap-4 block ${i === 1 ? "ring-1 ring-[rgba(0,255,136,0.2)]" : ""}`}
              >
                {card.badge && (
                  <span className="absolute top-4 right-4 bg-[#00FF88] text-[#0A0A0A] text-[11px] font-bold px-2.5 py-1 rounded-full shadow-[0_0_12px_rgba(0,255,136,0.55)]">{card.badge}</span>
                )}
                <div className="text-2xl">{card.icon}</div>
                <div>
                  <h3 className="font-bold text-[#F5F5F5] text-base mb-2">{card.tier}</h3>
                  <p className="text-sm text-[#6B6B6B] leading-relaxed">{card.desc}</p>
                </div>
                <div className="mt-auto pt-2 border-t border-[#2A2A2A] flex items-center justify-between">
                  <span className="text-xs text-[#00FF88] font-mono">{card.speed}</span>
                  <span className="text-[10px] text-[#3A3A3A] hover:text-[#6B6B6B] transition-colors">See pricing →</span>
                </div>
              </a>
            ))}
          </div>
          <div className="reveal mt-8 inline-flex items-center gap-2 bg-[rgba(0,255,136,0.06)] border border-[rgba(0,255,136,0.2)] rounded-full px-4 py-2 text-xs text-[#00FF88]">
            + Caveman Mode — strips AI filler words for 65% faster responses
          </div>
          <p className="reveal mt-3 text-xs font-mono text-[#2A4A2A]">
            🔒 Zero-knowledge · All processing runs on your device · No data ever leaves your machine
          </p>
        </div>
      </section>

      {/* ══════════════════════════ 5b. PROJECT FILES ════════════════════════ */}
      <section id="project-files" className="py-14 sm:py-24 px-5">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="reveal text-3xl sm:text-4xl font-bold text-[#F5F5F5] mb-4">Local folder context.</h2>
            <p className="reveal text-[#6B6B6B] max-w-xl mx-auto">
              Connect your IDE. Include your actual project files. Every AI session grounded in your real codebase — not a description of it.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {[
              { icon: "⊟", title: "IDE Connection + MCP Server", soon: true,  body: "Bridge your editor to ContextMover via the MCP server. Your active files and workspace state flow into every migration automatically." },
              { icon: "⬡", title: "GitHub Repo Extraction",        soon: false, body: "Scan your repository and pull the relevant files into any session. Your codebase travels with your context, not just a description of it." },
              { icon: "◈", title: "Local Folder Context",          soon: false, body: "Read files directly from your machine. No upload, no cloud roundtrip. Your project stays local and private while your AI stays fully informed." },
            ].map((card, i) => (
              <div key={i} className={`reveal reveal-d${i + 1} card-hover bg-[#1A1A1A] border border-[#2A2A2A] rounded-2xl p-7 text-left relative`}>
                {card.soon && (
                  <span className="absolute top-3 right-3 text-[9px] font-black uppercase tracking-widest text-[#3A3A3A] border border-[#2A2A2A] rounded px-1.5 py-0.5">Coming Soon</span>
                )}
                <div className="text-2xl mb-4">{card.icon}</div>
                <h3 className="font-semibold text-[#F5F5F5] mb-2 text-sm">{card.title}</h3>
                <p className="text-sm text-[#6B6B6B] leading-relaxed">{card.body}</p>
              </div>
            ))}
          </div>
          <p className="reveal text-center mt-8 text-xs text-[#3A3A3A] font-mono">
            Pro feature ·{" "}
            <a href="#pricing" className="text-[#00FF88]/40 hover:text-[#00FF88]/60 transition-colors">see plans →</a>
          </p>
        </div>
      </section>

      {/* ══════════════════════════ 6. HOW IT WORKS ══════════════════════════ */}
      <section id="how" className="py-14 sm:py-24 px-5">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="reveal text-3xl sm:text-4xl font-bold text-[#F5F5F5] mb-4">Three steps. Ten seconds.</h2>
          <p className="reveal text-[#6B6B6B] mb-16">No configuration. No API keys. No learning curve.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 relative">
            <div className="hidden md:block absolute top-10 left-[25%] right-[25%] h-px bg-gradient-to-r from-[#2A2A2A] via-[#00FF88]/30 to-[#2A2A2A]" />
            {STEPS.map((step, i) => (
              <div key={i} className={`reveal reveal-d${i + 1} relative flex flex-col items-center text-center gap-4`}>
                <div className="relative">
                  <div className="w-20 h-20 rounded-2xl bg-[#1A1A1A] border border-[#2A2A2A] flex items-center justify-center text-3xl shadow-[0_0_0_1px_rgba(0,255,136,0.06)]">
                    {step.icon}
                  </div>
                  <div className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-[#00FF88] text-[#0A0A0A] text-[10px] font-bold flex items-center justify-center">{i + 1}</div>
                </div>
                <h3 className="font-bold text-[#F5F5F5] text-lg">{step.title}</h3>
                <p className="text-sm text-[#6B6B6B] leading-relaxed max-w-xs">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════ 7. PRIVACY / TRUST ══════════════════════════ */}
      <section className="py-14 sm:py-24 px-5 bg-[#0A0F0A] border-y border-[rgba(0,255,136,0.08)]">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="reveal text-3xl sm:text-4xl font-bold text-[#F5F5F5] mb-4">Your context. Your device. Your control.</h2>
            <p className="reveal text-[#6B6B6B] max-w-md mx-auto">We designed ContextMover so our servers are never in the loop. Because they shouldn&apos;t be.</p>
          </div>
          <div className="flex flex-col gap-10 items-start">
            {/* Flow chart */}
            <div className="reveal w-full bg-[#111111] border border-[rgba(0,255,136,0.12)] rounded-2xl p-5 sm:p-7 font-mono text-xs sm:text-sm overflow-x-auto">
              <p className="text-[#F5F5F5] mb-1">Your Browser</p>
              <p className="text-[#00FF88]">│</p>
              <p><span className="text-[#00FF88]">├──</span> <span className="text-[#F5F5F5]">Captures session</span> <span className="text-[#6B6B6B]">→ IndexedDB (local)</span></p>
              <p className="text-[#00FF88]">│</p>
              <p><span className="text-[#00FF88]">├──</span> <span className="text-[#F5F5F5]">You click Migrate</span></p>
              <p className="text-[#00FF88]">│       │</p>
              <p className="pl-4"><span className="text-[#00FF88]">│       └──</span> <span className="text-[#F5F5F5]">Context built on YOUR device</span></p>
              <p className="text-[#00FF88] pl-4">│                   │</p>
              <p className="pl-4"><span className="text-[#00FF88]">│                   └──</span> <span className="text-[#F5F5F5]">Injected into target AI</span></p>
              <p className="text-[#00FF88]">│</p>
              <p><span className="text-[#00FF88]">└──</span> <span className="text-[#6B6B6B]">Optional: sync to personal cloud vault</span></p>
              <p className="text-[#00FF88] mt-3 text-xs">ContextMover servers: never in this chain.</p>
            </div>
            {/* Checklist */}
            <div className="reveal reveal-d1 flex-1 space-y-4">
              {[
                "User data never touches our servers — zero-knowledge architecture",
                "Context stays on your own machine (local IndexedDB only)",
                "Vault syncs only to YOUR personal Supabase — not ours",
                "We cannot read, sell, or access your conversations — ever",
                "Delete everything with one click — no server-side backups to purge",
                "No VC funding — we earn when you pay, not from your data",
              ].map((item, i) => (
                <div key={i} className="flex items-start gap-3">
                  <Check size={14} className="text-[#00FF88] shrink-0 mt-0.5" />
                  <span className="text-sm text-[#F5F5F5] leading-relaxed">{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════ 8. PLATFORM SUPPORT ══════════════════════════ */}
      <section id="platforms" className="py-14 sm:py-24 px-5 bg-[#111111]">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="reveal text-3xl sm:text-4xl font-bold text-[#F5F5F5] mb-4">Works where you work.</h2>
          <p className="reveal text-[#6B6B6B] mb-14">Every major AI platform. One extension.</p>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 mb-8">
            {PLATFORMS.map((p, i) => (
              <div
                key={i}
                className={`reveal reveal-d${(i % 3) + 1} card-hover bg-[#1A1A1A] border border-[#2A2A2A] rounded-2xl p-5 text-left flex flex-col gap-3 cursor-default`}
                style={{ ["--platform-color" as string]: p.color }}
              >
                <div className="flex items-center gap-2.5">
                  <span className={`w-3 h-3 rounded-full ${p.dot} shrink-0`} />
                  <span className="font-semibold text-[#F5F5F5] text-sm">{p.name}</span>
                </div>
                <div className="text-xs text-[#6B6B6B]">{p.sub}</div>
                <div className={`text-xs font-medium px-2 py-0.5 rounded-full w-fit ${p.badge === "Capture & Migrate" ? "bg-[rgba(0,255,136,0.08)] text-[#00FF88] border border-[rgba(0,255,136,0.2)]" : "bg-[#2A2A2A] text-[#6B6B6B]"}`}>
                  {p.badge}
                </div>
              </div>
            ))}
          </div>
          <div className="reveal flex flex-col sm:flex-row items-center justify-center gap-3 text-sm text-[#6B6B6B]">
            <span>More platforms coming soon.</span>
            <a
              href="mailto:hey@contextmover.app?subject=Platform%20suggestion"
              className="inline-flex items-center gap-1.5 text-[#00FF88]/70 hover:text-[#00FF88] transition-colors text-xs font-medium"
            >
              <Mail size={12} />
              Suggest a platform
            </a>
          </div>
        </div>
      </section>

      {/* ══════════════════════════ 8b. SUPER MEMORY ════════════════════════ */}
      <section id="super-memory" className="py-28 px-5 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl h-[500px] bg-[radial-gradient(ellipse_60%_60%_at_50%_50%,rgba(0,255,136,0.05),transparent)]" />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.006)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.006)_1px,transparent_1px)] bg-[size:52px_52px] opacity-50" />
        </div>
        <div className="relative z-10 max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-[rgba(0,255,136,0.06)] border border-[rgba(0,255,136,0.15)] rounded-full px-3.5 py-1 text-xs text-[#00FF88]/60 font-mono mb-8 reveal">
            <span className="w-1.5 h-1.5 rounded-full bg-[#00FF88]/60" />
            Coming soon
          </div>
          <h2 className="reveal text-4xl sm:text-5xl lg:text-6xl font-bold text-[#F5F5F5] mb-6 leading-tight tracking-tight">
            Super Memory.
          </h2>
          <p className="reveal text-xl sm:text-2xl text-[#00FF88]/50 font-mono mb-10">
            Your AI never forgets.
          </p>
          <p className="reveal text-[#6B6B6B] max-w-lg mx-auto mb-12 leading-relaxed">
            You build knowledge across hundreds of conversations. Right now, every new session
            starts from nothing.
            <br /><br />
            <span className="text-[#F5F5F5]/80">What if it didn&apos;t?</span>
          </p>
          <div className="reveal max-w-2xl mx-auto bg-[#080808] border border-[rgba(0,255,136,0.08)] rounded-2xl p-6 sm:p-8 font-mono text-xs sm:text-sm text-left">
            <div className="flex items-center gap-2 mb-5 pb-4 border-b border-[#151515]">
              <span className="w-2 h-2 rounded-full bg-[#FF4444]/50" />
              <span className="w-2 h-2 rounded-full bg-[#F59E0B]/50" />
              <span className="w-2 h-2 rounded-full bg-[#00FF88]/50" />
              <span className="text-[#2A2A2A] ml-2">super_memory — [access restricted]</span>
            </div>
            <p className="text-[#2A5A2A] mb-3"># persistent memory layer</p>
            <p className="mb-1"><span className="text-[#6B6B6B]">sessions_indexed</span>   <span className="text-[#00FF88]/40">=  ████████████</span></p>
            <p className="mb-1"><span className="text-[#6B6B6B]">knowledge_graph</span>    <span className="text-[#00FF88]/40">=  building...</span></p>
            <p className="mb-1"><span className="text-[#6B6B6B]">recall_accuracy</span>    <span className="text-[#00FF88]/40">=  ██████████░░</span></p>
            <p className="mb-1"><span className="text-[#6B6B6B]">cross_platform</span>     <span className="text-[#00FF88]/40">=  true</span></p>
            <p className="mb-1"><span className="text-[#6B6B6B]">zero_knowledge</span>     <span className="text-[#00FF88]/40">=  always</span></p>
            <p className="mt-4 text-[#1A3A1A]">status: not yet. but soon.</p>
            <p className="mt-1 text-[#00FF88]/20 animate-pulse">▌</p>
          </div>
          <p className="reveal mt-10 text-xs text-[#2A2A2A] font-mono">
            Be first to know:{" "}
            <a
              href="mailto:hey@contextmover.app?subject=Super%20Memory%20—%20notify%20me"
              className="text-[#00FF88]/30 hover:text-[#00FF88]/60 transition-colors"
            >
              hey@contextmover.app
            </a>
          </p>
        </div>
      </section>

      {/* ══════════════════════════ 9. PRICING ══════════════════════════ */}
      <section id="pricing" className="py-14 sm:py-24 px-5">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="reveal text-3xl sm:text-4xl font-bold text-[#F5F5F5] mb-4">Start free. Upgrade when you need more.</h2>
          <p className="reveal text-[#6B6B6B] mb-8">No credit card required. Cancel anytime.</p>
          {/* Toggles */}
          <div className="reveal flex flex-col sm:flex-row items-center justify-center gap-4 mb-10">
            <div className="flex items-center gap-2 bg-[#111] border border-[#2A2A2A] rounded-full p-1">
              <button
                onClick={() => setAnnual(false)}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${!annual ? "bg-[#00FF88] text-[#0A0A0A]" : "text-[#6B6B6B] hover:text-[#F5F5F5]"}`}
              >Monthly</button>
              <button
                onClick={() => setAnnual(true)}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${annual ? "bg-[#00FF88] text-[#0A0A0A]" : "text-[#6B6B6B] hover:text-[#F5F5F5]"}`}
              >Annual <span className="text-[10px] opacity-70">save 27%</span></button>
            </div>
            <div className="flex items-center gap-2 bg-[#111] border border-[#2A2A2A] rounded-full p-1">
              <button
                onClick={() => setIndiaMode(false)}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${!indiaMode ? "bg-[#1A1A1A] text-[#F5F5F5]" : "text-[#6B6B6B] hover:text-[#F5F5F5]"}`}
              >🌍 Global ($)</button>
              <button
                onClick={() => setIndiaMode(true)}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all ${indiaMode ? "bg-[#1A1A1A] text-[#F5F5F5]" : "text-[#6B6B6B] hover:text-[#F5F5F5]"}`}
              >🇮🇳 India (₹)</button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-5 mb-10">
            {/* FREE */}
            <div className="reveal card-hover bg-[#1A1A1A] border border-[#2A2A2A] rounded-2xl p-7 text-left flex flex-col">
              <div className="mb-6">
                <p className="text-xs text-[#6B6B6B] font-medium uppercase tracking-widest mb-2">Free</p>
                <p className="text-4xl font-bold text-[#F5F5F5]">{indiaMode ? "Free" : "$0"} <span className="text-sm font-normal text-[#6B6B6B]">/ forever</span></p>
              </div>
              <ul className="space-y-3 text-sm text-[#6B6B6B] flex-1 mb-8">
                {["Web session capture (all platforms)", "Basic migration + export", "10 sessions stored", "Full Context + Smart Summary tiers"].map((f) => (
                  <li key={f} className="flex items-start gap-2"><span className="text-[#00FF88] shrink-0">✓</span>{f}</li>
                ))}
              </ul>
              <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer" className="block text-center border border-[#2A2A2A] hover:border-[rgba(0,255,136,0.4)] text-[#F5F5F5] font-semibold py-2.5 rounded-lg transition-colors text-sm">
                Add to Chrome — free
              </a>
            </div>
            {/* PRO */}
            <div className="reveal reveal-d1 card-hover relative bg-[#0A0F0A] border-2 border-[#00FF88] rounded-2xl p-7 text-left flex flex-col shadow-[0_0_40px_rgba(0,255,136,0.12)]">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#00FF88] text-[#0A0A0A] text-[11px] font-bold px-3 py-0.5 rounded-full">MOST POPULAR</div>
              <div className="mb-6">
                <p className="text-xs text-[#00FF88] font-medium uppercase tracking-widest mb-2">Pro</p>
                <p className="text-4xl font-bold text-[#F5F5F5]">
                  {indiaMode ? (annual ? "₹158" : "₹199") : (annual ? "$4" : "$5")}
                  <span className="text-sm font-normal text-[#6B6B6B]"> / month</span>
                </p>
                <p className="text-xs text-[#6B6B6B] mt-1">{annual ? (indiaMode ? "billed ₹1,899/yr" : "billed $48/yr") : (indiaMode ? "or ₹158/mo billed annually" : "or $4/mo billed annually")}</p>
              </div>
              <ul className="space-y-3 text-sm text-[#6B6B6B] flex-1 mb-8">
                {["Unlimited sessions", "Attention Engine (semantic AI)", "IDE connection + MCP server", "GitHub repo extraction", "Priority updates"].map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <span className="text-[#00FF88] shrink-0">✓</span>
                    {f}
                    {f === "IDE connection + MCP server" && (
                      <span className="text-[9px] font-black uppercase tracking-widest text-[#3A3A3A] border border-[#2A2A2A] rounded px-1 py-0.5 shrink-0">Soon</span>
                    )}
                  </li>
                ))}
              </ul>
              <a href="/auth?mode=signup" className="block text-center bg-[#00FF88] text-[#0A0A0A] font-bold py-2.5 rounded-lg btn-primary text-sm">
                Start 14-day free trial
              </a>
            </div>
            {/* TEAM */}
            <div className="reveal reveal-d2 card-hover bg-[#1A1A1A] border border-[#2A2A2A] rounded-2xl p-7 text-left flex flex-col">
              <div className="mb-6">
                <p className="text-xs text-[#6B6B6B] font-medium uppercase tracking-widest mb-2">Team</p>
                <p className="text-4xl font-bold text-[#F5F5F5]">{indiaMode ? (annual ? "₹749" : "₹999") : (annual ? "$29" : "$39")} <span className="text-sm font-normal text-[#6B6B6B]">/ user / mo</span></p>
              </div>
              <ul className="space-y-3 text-sm text-[#6B6B6B] flex-1 mb-8">
                {["Everything in Pro", "Shared encrypted vaults", "Advanced mental modeling", "Admin dashboard + audit logs", "Priority support"].map((f) => (
                  <li key={f} className="flex items-start gap-2"><span className="text-[#00FF88] shrink-0">✓</span>{f}</li>
                ))}
              </ul>
              <div className="block text-center border border-[#2A2A2A] text-[#3A3A3A] font-semibold py-2.5 rounded-lg text-sm cursor-default select-none">
                Team plans coming soon
              </div>
            </div>
          </div>
          {/* Early bird */}
          <div className="reveal flex flex-col sm:flex-row items-center gap-3 bg-[#1A1A1A] border border-[#F59E0B]/30 rounded-2xl px-6 py-4 text-sm w-full sm:w-auto sm:inline-flex">
            <span className="text-lg">★</span>
            <span className="text-[#F59E0B] font-semibold">Early Bird: Lifetime Pro for $149</span>
            <span className="text-[#6B6B6B]">— first 500 only</span>
            <span className="text-[#F59E0B] font-mono font-bold"><Countdown /></span>
            <span className="text-[#6B6B6B] text-xs">remaining</span>
          </div>
          <p className="mt-6 text-xs text-[#3A3A3A]">7-day refund policy — no questions asked.</p>
          <p className="mt-2 text-xs font-mono text-[#2A4A2A]">🔒 Zero-knowledge — your data never touches our servers · vault syncs only to your own Supabase.</p>
        </div>
      </section>

      {/* ══════════════════════════ 10. BUILD WITH ME ══════════════════════════ */}
      <BuildWithMe />

      {/* ══════════════════════════ 11. FAQ ══════════════════════════ */}
      <section className="bg-[#111111] py-24 px-5">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="reveal text-3xl sm:text-4xl font-bold text-[#F5F5F5] mb-14">Questions.</h2>
          <FaqAccordion />
        </div>
      </section>

      {/* ═══════════════ TRUST BAR ═══════════════ */}
      <div className="bg-[#050F05] border-t border-[rgba(0,255,136,0.06)] py-3 px-5 text-center">
        <p className="text-xs font-mono text-[#2A6A2A]">
          🔒 <strong className="text-[#00FF88]">Zero-knowledge.</strong>{" "}
          Data never touches our servers · Context stays on your machine · Vault syncs to your own Supabase · We cannot read or sell your conversations.
        </p>
      </div>

      {/* ══════════════════════════ 11. FOOTER ══════════════════════════ */}
      <footer className="bg-[#0A0A0A] border-t border-[#2A2A2A] py-14 px-5">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-col gap-8 mb-10">
            {/* Brand */}
            <div className="flex flex-col gap-3 max-w-xs">
              <div className="flex items-center gap-2.5">
                <Image src="/logo.png" alt="ContextMover" width={56} height={56} style={{ height: 28, width: "auto" }} />
                <span className="font-bold text-[#F5F5F5]">ContextMover</span>
              </div>
              <p className="text-sm text-[#6B6B6B] leading-relaxed">Context Operating System for AI developers.</p>
              <p className="text-xs font-mono text-[#1A3A1A] leading-relaxed">🔒 Zero-knowledge — your conversations never touch our servers.</p>
            </div>
            {/* Nav links */}
            <div className="grid grid-cols-2 xs:grid-cols-2 sm:grid-cols-3 gap-x-10 gap-y-3 text-sm text-[#6B6B6B]">
              <a href="/dashboard" className="hover:text-[#F5F5F5] transition-colors">Dashboard</a>
              <a href="/pricing" className="hover:text-[#F5F5F5] transition-colors">Pricing</a>
              <a href="/docs" className="hover:text-[#F5F5F5] transition-colors">Docs</a>
              <a href="/privacy" className="hover:text-[#F5F5F5] transition-colors">Privacy</a>
              <a href="/terms" className="hover:text-[#F5F5F5] transition-colors">Terms</a>
              <a href="/contact" className="hover:text-[#F5F5F5] transition-colors">Contact</a>
              <a href="/feedback" className="hover:text-[#F5F5F5] transition-colors">Feedback</a>
              <a href="/auth" className="hover:text-[#F5F5F5] transition-colors">Log in</a>
              <a href="#" className="hover:text-[#F5F5F5] transition-colors text-[#3A3A3A]">Status ▸</a>
            </div>
            {/* Email widget (replaces desktop tagline) */}
            <div className="hidden md:block min-w-[180px]">
              <EmailWidget />
            </div>
          </div>
          <div className="border-t border-[#2A2A2A] pt-6 flex flex-col sm:flex-row justify-between items-center gap-3 text-xs text-[#6B6B6B]">
            <p>© 2026 ContextMover. Your context. Your control.</p>
            <p className="md:hidden">Built by developers, for developers. Pune, India</p>
          </div>
        </div>
      </footer>

    </div>
  );
}
