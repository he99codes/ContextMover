"use client";

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
  "Payment systems (Stripe, Razorpay)",
  "Fast turnaround — days not weeks",
  "Transparent pricing, no surprises",
  "Direct communication — no middlemen",
];

const MAILTO_HREF =
  "mailto:priyanshu@contextmover.com" +
  "?subject=Build%20with%20me%20%E2%80%94%20%5Bproject%20name%5D" +
  "&body=Hi%20Priyanshu%2C%0A%0AI%27d%20like%20to%20build%20%5Bdescribe%20your%20project%5D%0A%0AMy%20budget%3A%20%5Byour%20budget%5D%0AMy%20timeline%3A%20%5Byour%20timeline%5D";

export default function BuildWithMe() {
  return (
    <section className="py-24 sm:py-32 px-5 bg-[#0D0D0D]">
      <div className="max-w-5xl mx-auto">
        {/* Badge */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex items-center gap-2 bg-[rgba(0,255,136,0.08)] border border-[rgba(0,255,136,0.25)] rounded-full px-3.5 py-1 text-xs text-[#00FF88] font-medium reveal">
            <span className="w-2 h-2 rounded-full bg-[#00FF88] animate-pulse-green" />
            Available for projects
          </div>
        </div>

        {/* Headline */}
        <div className="text-center mb-4 reveal">
          <h2 className="text-[32px] sm:text-[40px] font-bold text-[#F5F5F5] leading-tight tracking-tight">
            Build your product<br className="hidden sm:block" /> with me.
          </h2>
        </div>

        {/* Subheadline */}
        <p className="text-center text-[#6B6B6B] max-w-xl mx-auto mb-14 leading-relaxed reveal">
          Got a side project or side hustle? I&apos;ll help you ship it — fast, clean, and at rates
          that don&apos;t feel like enterprise pricing.
        </p>

        {/* 3 Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-16">
          {FOR_CARDS.map((card, i) => (
            <div
              key={i}
              className={`reveal reveal-d${i + 1} card-hover bg-[#111111] border border-[#1A1A1A] hover:border-[#2A2A2A] rounded-2xl p-7 text-left flex flex-col gap-4 transition-colors duration-200`}
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
              <div
                key={i}
                className="flex items-start gap-3 group"
              >
                <Check
                  size={14}
                  className="text-[#00FF88] shrink-0 mt-1 transition-colors duration-150"
                />
                <span className="text-sm text-[#888888] group-hover:text-[#FFFFFF] transition-colors duration-150 leading-relaxed">
                  {skill}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Social proof / quote */}
        <div className="reveal mb-12 max-w-2xl mx-auto">
          <div className="bg-[#111111] border-l-[3px] border-[#00FF88] rounded-r-xl p-6 sm:p-7">
            <p className="italic text-[#888888] text-sm leading-relaxed mb-3">
              &ldquo;Built ContextMover end-to-end as a solo developer.
              Same speed. Same quality. Your product.&rdquo;
            </p>
            <p className="text-xs text-[#6B6B6B]">— Priyanshu, Builder of ContextMover</p>
          </div>
        </div>

        {/* Pricing teaser */}
        <p className="reveal text-center text-sm text-[#6B6B6B] max-w-md mx-auto mb-8 leading-relaxed">
          Rates that respect indie budgets.
          Every project is scoped and priced fairly.
          <span className="text-[#F5F5F5]"> First conversation is always free</span> — no commitment.
        </p>

        {/* CTAs */}
        <div className="reveal flex flex-col sm:flex-row items-center justify-center gap-4">
          <a
            href={MAILTO_HREF}
            className="bg-[#00FF88] text-[#0A0A0A] font-bold px-8 py-3.5 rounded-lg text-base w-full sm:w-auto text-center btn-primary shadow-[0_0_24px_rgba(0,255,136,0.25)]"
          >
            Let&apos;s talk →
          </a>
          <a
            href="https://contextmover.com"
            className="text-[#888888] hover:text-[#FFFFFF] transition-colors text-sm underline-offset-4 hover:underline"
          >
            See what I&apos;ve built →
          </a>
        </div>
      </div>
    </section>
  );
}
