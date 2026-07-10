"use client";
import React, { useState } from "react";
type Severity = "low"|"medium"|"high"|"critical";

export default function BugReportForm() {
  const [desc, setDesc]     = useState("");
  const [email, setEmail]   = useState("");
  const [sev, setSev]       = useState<Severity>("medium");
  const [status, setStatus] = useState<"idle"|"loading"|"ok"|"err">("idle");
  const [err, setErr]       = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (desc.trim().length < 10) { setErr("Please describe the issue (min 10 chars)."); return; }
    setStatus("loading"); setErr("");
    try {
      const r = await fetch("/api/support/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, description: desc, severity: sev, platform: "web" }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus("ok"); setDesc(""); setEmail("");
    } catch (e2) {
      setStatus("err");
      setErr(e2 instanceof Error ? e2.message : "Submission failed.");
    }
  }

  if (status === "ok")
    return <div className="rounded-[6px] border border-[#00D26A]/25 bg-[#00D26A]/6 px-5 py-4 text-[#00D26A] text-sm">Report received — we&apos;ll follow up within 24 h. Thank you.</div>;

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="block text-sm font-semibold text-[#F5F5F5] mb-1">Email (optional)</label>
        <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"
          className="w-full rounded-[6px] border border-[#2A2A2A] bg-[#111] px-3 py-2 text-sm text-[#F5F5F5] placeholder-[#444] outline-none focus:border-[#00D26A]/40" />
      </div>
      <div>
        <label className="block text-sm font-semibold text-[#F5F5F5] mb-1">Severity</label>
        <select value={sev} onChange={e=>setSev(e.target.value as Severity)}
          className="rounded-[6px] border border-[#2A2A2A] bg-[#111] px-3 py-2 text-sm text-[#F5F5F5] outline-none focus:border-[#00D26A]/40">
          <option value="low">Low — cosmetic</option>
          <option value="medium">Medium — workaround exists</option>
          <option value="high">High — feature broken</option>
          <option value="critical">Critical — data loss / blocked</option>
        </select>
      </div>
      <div>
        <label className="block text-sm font-semibold text-[#F5F5F5] mb-1">Description <span className="text-[#EF4444]">*</span></label>
        <textarea value={desc} onChange={e=>setDesc(e.target.value)} rows={5} required
          placeholder="Steps to reproduce, what you expected, what happened..."
          className="w-full rounded-[6px] border border-[#2A2A2A] bg-[#111] px-3 py-2 text-sm text-[#F5F5F5] placeholder-[#444] outline-none focus:border-[#00D26A]/40 resize-y" />
      </div>
      {err && <p className="text-sm text-[#EF4444]">{err}</p>}
      <button type="submit" disabled={status==="loading"}
        className="rounded-[6px] bg-[#00D26A] px-5 py-2 text-sm font-bold text-black disabled:opacity-50 hover:bg-[#00B85C] transition-colors">
        {status==="loading" ? "Sending…" : "Send Report"}
      </button>
    </form>
  );
}
