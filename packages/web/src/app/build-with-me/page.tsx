"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useState, useEffect } from "react";
import Image from "next/image";
import { Check } from "lucide-react";
import { CHROME_STORE_URL } from "@/config/urls";

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

const FOR_CARDS = [
  {
    emoji: "🚀",
    title: "Side Projects",
    body: "Solo builders who want a technical co-founder for a sprint. Idea → MVP in days, not months.",
  },
  {
    emoji: "⚡",
    title: "Side Hustles",
    body: "Builders monetizing a skill or product. Landing page, payment integration, automation — whatever makes it earn.",
  },
  {
    emoji: "🛠️",
    title: "Early Startups",
    body: "Pre-seed teams who need engineering done right without hiring a full team yet.",
  },
];

const SKILLS = [
  "Full-stack: Next.js, React, Node.js, Supabase",
  "Chrome extensions & browser automation",
  "AI integration (Claude, OpenAI, local LLMs)",
  "Payment systems (Razorpay, PayPal)",
  "Fast turnaround — days not weeks",
  "Transparent pricing, no surprises",
  "Direct communication — no middlemen",
];

type Status = "idle" | "loading" | "success" | "error";

export default function BuildWithMePage() {
  useScrollReveal();
  const [menuOpen, setMenuOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", message: "" });
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("loading");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setStatus("success");
        setForm({ name: "", email: "", message: "" });
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="bg-[#020202] text-[#F5F5F5] font-sans overflow-x-hidden relative" style={{
      background: `
        radial-gradient(ellipse 80% 50% at 20% 20%, rgba(0,255,136,0.03) 0%, transparent 60%),
        radial-gradient(ellipse 60% 40% at 80% 80%, rgba(0,180,255,0.03) 0%, transparent 60%),
        #020202
      `
    }}>
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-[#1A1A1A] bg-[#0A0A0A]/92 backdrop-blur-md transition-all">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 h-14 flex items-center justify-between">
          {/* Logo */}
          <a href="/" className="flex items-center gap-2.5 shrink-0">
            <Image src="/logo.png" alt="ContextMover" width={56} height={56} priority style={{ height: 32, width: "auto" }} />
            <span className="font-bold text-[#F5F5F5] tracking-tight">ContextMover</span>
          </a>

          {/* Desktop center nav */}
          <div className="hidden md:flex items-center gap-0.5">
            <a href="/" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[#111]">Home</a>
            <a href="/pricing" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[#111]">Pricing</a>
            <a href="/docs" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[#111]">Docs</a>
            <a href="/build-with-me" className="px-3 py-1.5 text-sm text-[#00FF88]/70 hover:text-[#00FF88] transition-colors rounded-md hover:bg-[#111]">Build with me</a>
          </div>

          {/* Desktop right */}
          <div className="hidden md:flex items-center gap-2">
            <a href="/auth" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors">Log in</a>
            <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer" className="bg-[#00FF88] text-[#0A0A0A] font-semibold text-sm px-4 py-1.5 rounded-md hover:bg-[#00CC6A] transition-colors shadow-[0_0_12px_rgba(0,255,136,0.2)]">Get for free</a>
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
              {([
                ["Home", "/"],
                ["Pricing", "/pricing"],
                ["Docs", "/docs"],
                ["Build with me", "/build-with-me"],
              ] as const).map(([label, href]) => (
                <a key={label} href={href} className={`flex items-center text-[18px] min-h-[56px] px-3 border-b border-[#111] active:opacity-70 ${label === "Build with me" ? "text-[#00FF88]/70" : "text-[#6B6B6B]"}`} onClick={() => setMenuOpen(false)}>{label}</a>
              ))}
            </nav>
            {/* Overlay CTAs */}
            <div className="shrink-0 px-5 pb-8 pt-4 flex flex-col gap-3 border-t border-[#1A1A1A]">
              <a href="/auth" className="flex items-center justify-center border border-[#2A2A2A] text-[#F5F5F5] font-semibold text-base h-[52px] rounded-lg active:opacity-80" onClick={() => setMenuOpen(false)}>Log in</a>
              <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center bg-[#00FF88] text-[#0A0A0A] font-bold text-base h-[52px] rounded-lg active:scale-95 transition-transform shadow-[0_0_16px_rgba(0,255,136,0.25)]" onClick={() => setMenuOpen(false)}>Add to Chrome — free</a>
            </div>
          </div>
        )}
      </nav>

      {/* Main content with top padding for navbar */}
      <div className="pt-14">
        <section
          id="build-with-me"
          className="py-16 sm:py-24 md:py-32 px-4 sm:px-8 md:px-16 bg-[#02050A] border-y border-[rgba(99,102,241,0.15)] relative overflow-hidden"
        >
          {/* Purple radial glow — top and bottom */}
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-4xl h-96 bg-[radial-gradient(ellipse_80%_60%_at_50%_0%,rgba(99,102,241,0.10),transparent)]" />
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full max-w-3xl h-64 bg-[radial-gradient(ellipse_60%_60%_at_50%_100%,rgba(99,102,241,0.07),transparent)]" />
            <div className="absolute top-1/4 right-0 w-[400px] h-[400px] rounded-full bg-[#6366f1] blur-[80px] opacity-[0.04]" />
            <div className="absolute bottom-1/4 left-0 w-[300px] h-[300px] rounded-full bg-[#818cf8] blur-[80px] opacity-[0.03]" />
          </div>

          <div className="relative z-10 max-w-5xl mx-auto">

            {/* Badge */}
            <div className="flex justify-center mb-8">
              <div className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold reveal" style={{
                background: "rgba(99,102,241,0.12)",
                border: "1px solid rgba(99,102,241,0.40)",
                color: "#818cf8",
                boxShadow: "0 0 20px rgba(99,102,241,0.15)"
              }}>
                <span className="w-2 h-2 rounded-full bg-[#818cf8] animate-pulse" />
                Available for projects · Let&apos;s build together
              </div>
            </div>

            {/* Headline */}
            <div className="text-center mb-4 reveal">
              <h2 className="text-[40px] sm:text-[52px] font-bold text-[#F5F5F5] leading-tight tracking-tight">
                Build your <span className="text-[#818cf8]">product</span><br className="hidden sm:block" /> with me.
              </h2>
            </div>

            {/* Subheadline */}
            <p className="text-center text-[#6B6B6B] max-w-xl mx-auto mb-4 leading-relaxed reveal">
              Got a side project, side hustle, or early startup? I&apos;ll help you ship it —
              fast, clean, and at rates that don&apos;t feel like enterprise pricing.
            </p>
            <p className="text-center text-sm text-[#818cf8]/60 font-mono mb-14 reveal">
              This is a collaboration and partnership opportunity — not an agency engagement.
            </p>

            {/* 3 Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-16">
              {FOR_CARDS.map((card, i) => (
                <div
                  key={i}
                  className={`reveal reveal-d${i + 1} card-hover rounded-2xl p-7 text-left flex flex-col gap-4 transition-colors duration-200`}
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    borderLeft: "2px solid rgba(99,102,241,0.3)"
                  }}
                >
                  <div className="text-[32px] leading-none" style={{ filter: "drop-shadow(0 0 8px rgba(99,102,241,0.3))" }}>{card.emoji}</div>
                  <h3 className="font-semibold text-[#F5F5F5] text-base">{card.title}</h3>
                  <p className="text-sm text-[#6B6B6B] leading-relaxed">{card.body}</p>
                </div>
              ))}
            </div>

            {/* What I bring */}
            <div className="reveal mb-16">
              <h3 className="text-sm font-semibold text-[#F5F5F5] uppercase tracking-widest mb-6 text-center">
                What I bring
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 max-w-2xl mx-auto">
                {SKILLS.map((skill, i) => (
                  <div key={i} className="flex items-start gap-3 group">
                    <Check size={14} className="text-[#818cf8] shrink-0 mt-1 transition-colors duration-150" />
                    <span className="text-sm text-[#888888] group-hover:text-[#FFFFFF] transition-colors duration-150 leading-relaxed">
                      {skill}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Quote */}
            <div className="reveal mb-14 max-w-2xl mx-auto">
              <div className="rounded-r-xl p-6 sm:p-7" style={{
                background: "rgba(255,255,255,0.02)",
                borderLeft: "3px solid #818cf8"
              }}>
                <p className="italic text-[#888888] text-sm leading-relaxed mb-3">
                  &ldquo;Built ContextMover end-to-end as a solo developer.
                  Same speed. Same quality. Your product.&rdquo;
                </p>
                <p className="text-xs text-[#6B6B6B]">— Priyanshu, Builder of ContextMover</p>
              </div>
            </div>

            {/* ── Contact form ───────────────────────────────────────────────── */}
            <div className="reveal max-w-xl mx-auto">
              <h3 className="text-center text-sm font-semibold text-[#F5F5F5] uppercase tracking-widest mb-2">
                Start a conversation
              </h3>
              <p className="text-center text-xs text-[#6B6B6B] mb-8">
                Tell me about your project. I read every message and reply within 24 hours.
              </p>

              {status === "success" ? (
                <div className="text-center py-14 rounded-2xl" style={{
                  border: "1px solid rgba(99,102,241,0.2)",
                  background: "rgba(99,102,241,0.04)"
                }}>
                  <div className="text-3xl mb-4">✓</div>
                  <p className="text-[#818cf8] font-semibold mb-1">Message sent.</p>
                  <p className="text-sm text-[#6B6B6B]">I&apos;ll reply within 24 hours.</p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-4">
                  <input
                    type="text"
                    placeholder="Your name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                    className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(99,102,241,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors"
                  />
                  <input
                    type="email"
                    placeholder="Your email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    required
                    className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(99,102,241,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors"
                  />
                  <textarea
                    placeholder="Tell me about your project — what you're building, your timeline, and your budget"
                    value={form.message}
                    onChange={(e) => setForm({ ...form, message: e.target.value })}
                    required
                    rows={4}
                    className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(99,102,241,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors resize-none"
                  />
                  {status === "error" && (
                    <p className="text-xs text-[#EF4444]">
                      Something went wrong. Email me directly at{" "}
                      <a href="mailto:hey@contextmover.com" className="underline">
                        hey@contextmover.com
                      </a>
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={status === "loading"}
                    className="w-full font-bold py-3.5 rounded-lg text-sm btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      background: "#818cf8",
                      color: "#0A0A0A",
                      boxShadow: "0 0 24px rgba(99,102,241,0.25)"
                    }}
                  >
                    {status === "loading" ? "Sending…" : "Send message →"}
                  </button>
                </form>
              )}

              <p className="text-center text-xs text-[#3A3A3A] mt-5">
                Rates that respect indie budgets.{" "}
                <span className="text-[#6B6B6B]">First conversation is always free — no commitment.</span>
              </p>
            </div>

          </div>
        </section>
      </div>
    </div>
  );
}
