"use client";

import { useState } from "react";
import { Check } from "lucide-react";

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

export default function BuildWithMe() {
  const [form,   setForm]   = useState({ name: "", email: "", message: "" });
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("loading");
    try {
      const res = await fetch("/api/contact", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(form),
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
    <section
      id="build-with-me"
      className="py-24 sm:py-32 px-5 bg-[#020A02] border-y border-[rgba(0,255,136,0.15)] relative overflow-hidden"
    >
      {/* Green radial glow — top and bottom */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-4xl h-96 bg-[radial-gradient(ellipse_80%_60%_at_50%_0%,rgba(0,255,136,0.10),transparent)]" />
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full max-w-3xl h-64 bg-[radial-gradient(ellipse_60%_60%_at_50%_100%,rgba(0,255,136,0.07),transparent)]" />
      </div>

      <div className="relative z-10 max-w-5xl mx-auto">

        {/* Badge */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex items-center gap-2 bg-[rgba(0,255,136,0.12)] border border-[rgba(0,255,136,0.40)] rounded-full px-4 py-1.5 text-xs text-[#00FF88] font-semibold reveal shadow-[0_0_20px_rgba(0,255,136,0.15)]">
            <span className="w-2 h-2 rounded-full bg-[#00FF88] animate-pulse-green" />
            Available for projects · Let&apos;s build together
          </div>
        </div>

        {/* Headline */}
        <div className="text-center mb-4 reveal">
          <h2 className="text-[40px] sm:text-[52px] font-bold text-[#F5F5F5] leading-tight tracking-tight">
            Build your product<br className="hidden sm:block" /> with me.
          </h2>
        </div>

        {/* Subheadline */}
        <p className="text-center text-[#6B6B6B] max-w-xl mx-auto mb-4 leading-relaxed reveal">
          Got a side project, side hustle, or early startup? I&apos;ll help you ship it —
          fast, clean, and at rates that don&apos;t feel like enterprise pricing.
        </p>
        <p className="text-center text-sm text-[#00FF88]/60 font-mono mb-14 reveal">
          This is a collaboration and partnership opportunity — not an agency engagement.
        </p>

        {/* 3 Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-16">
          {FOR_CARDS.map((card, i) => (
            <div
              key={i}
              className={`reveal reveal-d${i + 1} card-hover bg-[#0A1A0A] border border-[rgba(0,255,136,0.10)] hover:border-[rgba(0,255,136,0.25)] rounded-2xl p-7 text-left flex flex-col gap-4 transition-colors duration-200`}
            >
              <div className="text-[32px] leading-none">{card.emoji}</div>
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
                <Check size={14} className="text-[#00FF88] shrink-0 mt-1 transition-colors duration-150" />
                <span className="text-sm text-[#888888] group-hover:text-[#FFFFFF] transition-colors duration-150 leading-relaxed">
                  {skill}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Quote */}
        <div className="reveal mb-14 max-w-2xl mx-auto">
          <div className="bg-[#0A1A0A] border-l-[3px] border-[#00FF88] rounded-r-xl p-6 sm:p-7">
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
            <div className="text-center py-14 border border-[rgba(0,255,136,0.2)] rounded-2xl bg-[rgba(0,255,136,0.04)]">
              <div className="text-3xl mb-4">✓</div>
              <p className="text-[#00FF88] font-semibold mb-1">Message sent.</p>
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
                className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(0,255,136,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors"
              />
              <input
                type="email"
                placeholder="Your email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(0,255,136,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors"
              />
              <textarea
                placeholder="Tell me about your project — what you're building, your timeline, and your budget"
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
                required
                rows={4}
                className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(0,255,136,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors resize-none"
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
                className="w-full bg-[#00FF88] text-[#0A0A0A] font-bold py-3.5 rounded-lg text-sm btn-primary shadow-[0_0_24px_rgba(0,255,136,0.25)] hover:bg-[#00CC6A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
  );
}
