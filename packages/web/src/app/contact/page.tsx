"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";

type Status = "idle" | "loading" | "success" | "error";

export default function ContactPage() {
  const [form,   setForm]   = useState({ name: "", email: "", subject: "", message: "" });
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
      setStatus(res.ok ? "success" : "error");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5] font-sans flex flex-col items-center justify-center px-5 py-16">

      {/* Logo */}
      <Link href="/" className="flex items-center gap-2.5 mb-10 opacity-80 hover:opacity-100 transition-opacity">
        <Image src="/logo.png" alt="ContextMover" width={56} height={56} style={{ height: 28, width: "auto" }} />
        <span className="font-bold text-[#F5F5F5]">ContextMover</span>
      </Link>

      <div className="w-full max-w-lg bg-[#111111] border border-[#2A2A2A] rounded-2xl p-8 shadow-[0_0_40px_rgba(0,0,0,0.6)]">

        {status === "success" ? (
          <div className="text-center py-14">
            <div className="text-4xl mb-5">✓</div>
            <p className="text-[#00FF88] font-semibold text-lg mb-1">Message sent.</p>
            <p className="text-sm text-[#6B6B6B] mb-8">We&apos;ll reply within 24 hours.</p>
            <button
              onClick={() => { setStatus("idle"); setForm({ name: "", email: "", subject: "", message: "" }); }}
              className="text-xs text-[#6B6B6B] hover:text-[#F5F5F5] underline underline-offset-2 transition-colors"
            >
              Send another message →
            </button>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-[#F5F5F5] mb-1">Contact us</h1>
            <p className="text-sm text-[#6B6B6B] mb-8">We read every message and usually reply within 24 hours.</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold text-[#6B6B6B] uppercase tracking-widest">Name</label>
                  <input
                    type="text"
                    placeholder="Your name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                    className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(0,255,136,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-semibold text-[#6B6B6B] uppercase tracking-widest">Email</label>
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    required
                    className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(0,255,136,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-[#6B6B6B] uppercase tracking-widest">Subject</label>
                <input
                  type="text"
                  placeholder="What's this about?"
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  required
                  className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(0,255,136,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-[#6B6B6B] uppercase tracking-widest">Message</label>
                <textarea
                  placeholder="How can we help?"
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                  required
                  rows={5}
                  className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(0,255,136,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors resize-none"
                />
              </div>

              {status === "error" && (
                <p className="text-xs text-[#EF4444]">
                  Something went wrong. Email us at{" "}
                  <a href="mailto:hey@contextmover.com" className="underline">hey@contextmover.com</a>
                </p>
              )}

              <button
                type="submit"
                disabled={status === "loading"}
                className="w-full bg-[#00FF88] text-[#0A0A0A] font-bold py-3.5 rounded-lg text-sm shadow-[0_0_24px_rgba(0,255,136,0.2)] hover:bg-[#00CC6A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status === "loading" ? "Sending…" : "Send message →"}
              </button>
            </form>
          </>
        )}
      </div>

      <p className="mt-6 text-xs text-[#3A3A3A]">
        Or email us directly at{" "}
        <a href="mailto:hey@contextmover.com" className="text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors">
          hey@contextmover.com
        </a>
      </p>
    </div>
  );
}
