import Link from "next/link";
import { Check, Zap, Shield, ChevronRight } from "lucide-react";

export const metadata = { title: "Pricing — ContextForge" };

const FREE_FEATURES = [
  "Capture sessions on Claude, ChatGPT, Gemini, Grok, Perplexity, DeepSeek",
  "Full Context migration (Tier 1)",
  "6 most recent messages always preserved",
  "Local IndexedDB storage — zero ContextForge access",
  "Export sessions (JSON, Markdown, plain text)",
  "Prompt template library (15 system templates)",
];

const PRO_FEATURES = [
  "Everything in Free",
  "Smart Summary compression (Tier 2)",
  "Attention Engine — semantic memory graph (Tier 3)",
  "Personal Supabase vault sync + realtime",
  "Cross-device session access",
  "Super Memory across all platforms",
  "Unlimited prompt templates",
  "Priority support",
];

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5]">
      <div className="max-w-4xl mx-auto px-6 py-16">
        <div className="mb-2 flex justify-center">
          <Link href="/" className="text-xs font-mono text-[#6B6B6B] hover:text-[#00FF88] transition-colors">
            ← ContextForge
          </Link>
        </div>
        <div className="mb-12 text-center">
          <h1 className="text-3xl font-black uppercase text-[#00FF88]" style={{ letterSpacing: "0.12em", textShadow: "0 0 24px rgba(0,255,136,0.3)" }}>
            Pricing
          </h1>
          <p className="mt-3 text-sm text-[#6B6B6B]">Start free. Your data always stays yours.</p>
        </div>

        {/* Privacy guarantee */}
        <div className="mb-10 flex items-center justify-center gap-2 rounded-[8px] border border-[#00FF88]/15 bg-[#00FF88]/5 px-5 py-3">
          <Shield size={14} className="text-[#00FF88]" />
          <p className="text-xs font-mono text-[#2A6A2A]">
            Zero-knowledge — your conversations <strong className="text-[#00FF88]">never touch our servers</strong>, on any plan.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Free */}
          <div className="rounded-[10px] border border-[#2A2A2A] bg-[#111] p-7">
            <div className="mb-5">
              <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#6B6B6B]">Free forever</p>
              <p className="mt-1 text-4xl font-black text-[#F5F5F5]">$0</p>
              <p className="mt-0.5 text-xs text-[#6B6B6B]">No credit card required</p>
            </div>
            <ul className="mb-7 space-y-2.5">
              {FREE_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <Check size={13} className="mt-0.5 shrink-0 text-[#00FF88]" />
                  <span className="text-xs text-[#B0B0B0]">{f}</span>
                </li>
              ))}
            </ul>
            <Link
              href="/auth"
              className="flex w-full items-center justify-center gap-2 rounded-[6px] border border-[#2A2A2A] px-4 py-3 text-sm font-semibold text-[#F5F5F5] hover:border-[#3A3A3A] hover:bg-[#1A1A1A] transition-all"
            >
              Get started free
            </Link>
          </div>

          {/* Pro */}
          <div className="relative rounded-[10px] border border-[#00FF88]/30 bg-[#0D1A0D] p-7" style={{ boxShadow: "0 0 40px rgba(0,255,136,0.08)" }}>
            <div className="absolute -top-3 right-5">
              <span className="rounded-full border border-[#00FF88]/30 bg-[#00FF88]/10 px-3 py-1 text-[9px] font-black uppercase tracking-widest text-[#00FF88]">
                Most Popular
              </span>
            </div>
            <div className="mb-5">
              <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#00FF88]">Pro</p>
              <div className="flex items-baseline gap-1 mt-1">
                <p className="text-4xl font-black text-[#F5F5F5]">$9</p>
                <p className="text-sm text-[#6B6B6B]">/month</p>
              </div>
              <p className="mt-0.5 text-xs text-[#6B6B6B]">or $79/year — save 27%</p>
            </div>
            <ul className="mb-7 space-y-2.5">
              {PRO_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <Check size={13} className="mt-0.5 shrink-0 text-[#00FF88]" />
                  <span className="text-xs text-[#B0B0B0]">{f}</span>
                </li>
              ))}
            </ul>
            <Link
              href="/auth"
              className="flex w-full items-center justify-center gap-2 rounded-[6px] bg-[#00FF88] px-4 py-3 text-sm font-black text-black hover:bg-[#00FF88]/90 transition-all"
            >
              <Zap size={14} />
              Upgrade to Pro
              <ChevronRight size={14} />
            </Link>
          </div>
        </div>

        <p className="mt-10 text-center text-xs text-[#3A3A3A]">
          Questions? <a href="mailto:hey@contextforge.app" className="text-[#00FF88] hover:underline">hey@contextforge.app</a>
        </p>
      </div>
    </div>
  );
}
