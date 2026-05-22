"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useState } from "react";

const FREE_FEATURES = [
  { text: "10 Full Context migrations/month", soon: false },
  { text: "10 Smart Summary migrations/month", soon: false },
  { text: "50 Attention Engine migrations/month", soon: false },
  { text: "Basic session history", soon: false },
  { text: "Community support", soon: false },
];

const PRO_FEATURES = [
  { text: "Unlimited Full Context migrations", soon: false },
  { text: "Unlimited Smart Summary migrations", soon: false },
  { text: "Unlimited Attention Engine migrations", soon: false },
  { text: "Unlimited session history", soon: false },
  { text: "Domain-specific migration (Coding, Research, Writing)", soon: false },
  { text: "Google Drive sync", soon: false },
  { text: "Priority updates & support", soon: false },
  { text: "IDE & GitHub integration", soon: true },
  { text: "Local Folder integration", soon: true },
];

export default function PricingSection() {
  const [isAnnual, setIsAnnual] = useState(true);

  return (
    <section className="min-h-screen py-24 px-4" style={{ background: "#050505" }}>
      {/* Heading Block */}
      <div className="text-center">
        <h1 className="text-5xl font-bold text-white tracking-tight">
          Choose Your Plan
        </h1>
        <p className="text-lg text-zinc-400 mt-3 max-w-xl mx-auto text-center">
          Unlock the full power of context migration
        </p>
      </div>

      {/* Toggle */}
      <div className="flex items-center justify-center gap-4 mt-10">
        <span className={`text-sm font-medium ${!isAnnual ? "text-white" : "text-zinc-500"}`}>
          Monthly
        </span>
        <button
          onClick={() => setIsAnnual((v) => !v)}
          className="relative w-12 h-6 rounded-full transition-colors duration-300 focus:outline-none"
          style={{ background: isAnnual ? "#7c3aed" : "#3f3f46" }}
          aria-label="Toggle billing period"
        >
          <span
            className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-300"
            style={{ transform: isAnnual ? "translateX(24px)" : "translateX(0px)" }}
          />
        </button>
        <span className={`text-sm font-medium ${isAnnual ? "text-white" : "text-zinc-500"}`}>
          Annual
        </span>
        {isAnnual && (
          <span className="bg-emerald-500/20 text-emerald-400 text-xs font-bold px-2 py-0.5 rounded-full border border-emerald-500/30">
            Save 33%
          </span>
        )}
      </div>

      {/* Cards */}
      <div className="flex flex-col md:flex-row gap-6 items-stretch mt-12 max-w-5xl mx-auto">

        {/* ── Card 1: Free ── */}
        <div
          className="flex-1 flex flex-col rounded-2xl p-8"
          style={{
            background: "#0f0f0f",
            border: "1px solid #1f1f1f",
          }}
        >
          <div>
            <div className="flex items-end gap-1">
              <span className="text-5xl font-bold text-white">₹0</span>
              <span className="text-zinc-500 text-sm mb-2">/ month</span>
            </div>
            <p className="text-zinc-400 text-sm mt-2">Perfect for trying ContextMover</p>
          </div>

          <div className="border-t border-zinc-800 my-6" />

          <ul className="flex flex-col gap-3 flex-1">
            {FREE_FEATURES.map((f) => (
              <li key={f.text} className="flex items-start gap-2 text-sm text-zinc-300">
                <span className="text-emerald-400 mt-0.5 shrink-0">✓</span>
                <span>{f.text}</span>
              </li>
            ))}
          </ul>

          <a
            href="/auth?plan=free"
            className="mt-8 block w-full text-center rounded-xl py-3 font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
            style={{ border: "1px solid #2a2a2a" }}
          >
            Get Started Free
          </a>
        </div>

        {/* ── Card 2: Pro Early Bird (featured) ── */}
        <div
          className="flex-1 flex flex-col rounded-2xl p-8 relative md:-mt-2 md:-mb-2"
          style={{
            background: "#0a0a0f",
            border: "1.5px solid #7c3aed",
            boxShadow: "0 0 40px rgba(124, 58, 237, 0.15)",
          }}
        >
          {/* Most Popular badge */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <span
              className="text-white text-xs font-bold px-4 py-1 rounded-full whitespace-nowrap"
              style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}
            >
              🔥 Most Popular
            </span>
          </div>

          {/* Early Bird banner */}
          <div
            className="mt-2 text-center rounded-lg px-4 py-2 text-emerald-400 text-xs font-medium"
            style={{
              background: "rgba(16, 185, 129, 0.1)",
              border: "1px solid rgba(16, 185, 129, 0.3)",
            }}
          >
            ⚡ Early Bird — First 499 users · Limited spots remaining
          </div>

          {/* Price */}
          <div className="mt-4">
            {isAnnual ? (
              <>
                <div className="flex items-end gap-1">
                  <span className="text-5xl font-bold text-white">₹2,399</span>
                  <span className="text-zinc-400 text-sm mb-2">/ year</span>
                </div>
                <p className="text-emerald-400 text-xs mt-1">₹200/month · Save ₹1,189</p>
              </>
            ) : (
              <div className="flex items-end gap-1">
                <span className="text-5xl font-bold text-white">₹299</span>
                <span className="text-zinc-400 text-sm mb-2">/ month</span>
              </div>
            )}
            <p className="text-zinc-400 text-sm mt-2">Everything you need, nothing you don&apos;t</p>
          </div>

          <div className="my-6" style={{ borderTop: "1px solid rgba(88, 28, 235, 0.3)" }} />

          <ul className="flex flex-col gap-3 flex-1">
            {PRO_FEATURES.map((f) => (
              <li key={f.text} className="flex items-start gap-2 text-sm">
                {f.soon ? (
                  <>
                    <span className="text-zinc-500 mt-0.5 shrink-0">🔜</span>
                    <span className="text-zinc-500 italic">{f.text} <span className="not-italic text-zinc-600">(Coming Soon)</span></span>
                  </>
                ) : (
                  <>
                    <span className="text-purple-400 mt-0.5 shrink-0">✓</span>
                    <span className="text-zinc-200">{f.text}</span>
                  </>
                )}
              </li>
            ))}
          </ul>

          <a
            href="/auth?plan=pro-early"
            className="mt-8 block w-full text-center rounded-xl py-3.5 font-bold text-white transition-opacity hover:opacity-90"
            style={{
              background: "linear-gradient(135deg, #7c3aed, #4f46e5)",
              boxShadow: "0 4px 20px rgba(124, 58, 237, 0.4)",
            }}
          >
            Claim Early Bird Price →
          </a>
        </div>

        {/* ── Card 3: Pro ── */}
        <div
          className="flex-1 flex flex-col rounded-2xl p-8"
          style={{
            background: "#0f0f0f",
            border: "1px solid #1f1f1f",
          }}
        >
          <div>
            {isAnnual ? (
              <>
                <div className="flex items-end gap-1">
                  <span className="text-5xl font-bold text-white">₹3,999</span>
                  <span className="text-zinc-500 text-sm mb-2">/ year</span>
                </div>
                <p className="text-blue-400 text-xs mt-1">₹333/month · Save ₹1,989</p>
              </>
            ) : (
              <div className="flex items-end gap-1">
                <span className="text-5xl font-bold text-white">₹499</span>
                <span className="text-zinc-500 text-sm mb-2">/ month</span>
              </div>
            )}
            <p className="text-zinc-400 text-sm mt-2">For power users who need everything</p>
          </div>

          <div className="border-t border-zinc-800 my-6" />

          <ul className="flex flex-col gap-3 flex-1">
            {PRO_FEATURES.map((f) => (
              <li key={f.text} className="flex items-start gap-2 text-sm">
                {f.soon ? (
                  <>
                    <span className="text-zinc-500 mt-0.5 shrink-0">🔜</span>
                    <span className="text-zinc-500 italic">{f.text} <span className="not-italic text-zinc-600">(Coming Soon)</span></span>
                  </>
                ) : (
                  <>
                    <span className="text-blue-400 mt-0.5 shrink-0">✓</span>
                    <span className="text-zinc-300">{f.text}</span>
                  </>
                )}
              </li>
            ))}
          </ul>

          <a
            href="/auth?plan=pro"
            className="mt-8 block w-full text-center rounded-xl py-3 font-medium text-blue-400 transition-colors hover:bg-blue-950/50"
            style={{ border: "1px solid #3b82f6" }}
          >
            Upgrade to Pro →
          </a>
        </div>

      </div>

      <div className="text-center mt-10 space-y-2 px-10 pb-10">
        <p className="text-zinc-500 text-s">
          🔒 Zero-knowledge — your data never touches our servers · vault syncs only to your own Supabase
        </p>
        <p className="text-zinc-500 text-s">
          ❤️ Built by an indie developer. Every subscription directly supports the person writing the code, not a corporation.
        </p>
      </div>
    </section>
  );
}
