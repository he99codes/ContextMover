"use client";

import { useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

export default function EmailWidget() {
  const [form,   setForm]   = useState({ email: "", message: "" });
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("loading");
    try {
      const res = await fetch("/api/contact", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          email:   form.email,
          message: form.message,
          subject: "Quick message — footer widget",
        }),
      });
      setStatus(res.ok ? "success" : "error");
    } catch {
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div>
        <p className="text-xs font-semibold text-[#F5F5F5] uppercase tracking-widest mb-3">Email us</p>
        <p className="text-sm text-[#00FF88] font-semibold">✓ Sent. We&apos;ll be in touch.</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs font-semibold text-[#F5F5F5] uppercase tracking-widest mb-3">Email us</p>
      <form onSubmit={handleSubmit} className="space-y-2.5">
        <input
          type="email"
          placeholder="your@email.com"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          required
          className="w-full bg-[#111111] border border-[#2A2A2A] focus:border-[rgba(0,255,136,0.35)] rounded-md px-3 py-2 text-xs text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors"
        />
        <input
          type="text"
          placeholder="Quick message…"
          value={form.message}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
          required
          className="w-full bg-[#111111] border border-[#2A2A2A] focus:border-[rgba(0,255,136,0.35)] rounded-md px-3 py-2 text-xs text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors"
        />
        {status === "error" && (
          <p className="text-[10px] text-[#EF4444]">
            Failed —{" "}
            <a href="mailto:hey@contextmover.app" className="underline">email us directly</a>
          </p>
        )}
        <button
          type="submit"
          disabled={status === "loading"}
          className="w-full bg-[#00FF88] text-[#0A0A0A] font-bold py-2 rounded-md text-xs hover:bg-[#00CC6A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {status === "loading" ? "Sending…" : "Send →"}
        </button>
      </form>
    </div>
  );
}
