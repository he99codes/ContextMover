"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";

type Status = "idle" | "loading" | "success" | "error";

const RATINGS = [
  { score: 1, emoji: "😕", label: "Disappointed" },
  { score: 2, emoji: "😐", label: "Meh"          },
  { score: 3, emoji: "🙂", label: "It's ok"      },
  { score: 4, emoji: "😊", label: "Good"         },
  { score: 5, emoji: "🤩", label: "Amazing!"     },
] as const;

export default function FeedbackPage() {
  const [rating,   setRating]   = useState<number | null>(null);
  const [feedback, setFeedback] = useState("");
  const [email,    setEmail]    = useState("");
  const [status,   setStatus]   = useState<Status>("idle");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!rating) return;
    setStatus("loading");
    try {
      const res = await fetch("/api/feedback", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          rating,
          feedback,
          email: email.trim() || undefined,
        }),
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

      <div className="w-full max-w-md bg-[#111111] border border-[#2A2A2A] rounded-2xl p-8 shadow-[0_0_40px_rgba(0,0,0,0.6)]">

        {status === "success" ? (
          <div className="text-center py-14">
            <div className="text-5xl mb-5">🤩</div>
            <p className="text-[#00FF88] font-semibold text-lg mb-1">Thanks for the feedback!</p>
            <p className="text-sm text-[#6B6B6B]">It genuinely helps us improve ContextMover.</p>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-[#F5F5F5] mb-1">Share feedback</h1>
            <p className="text-sm text-[#6B6B6B] mb-8">How&apos;s ContextMover working for you?</p>

            <form onSubmit={handleSubmit} className="space-y-6">

              {/* Rating */}
              <div>
                <label className="text-[10px] font-semibold text-[#6B6B6B] uppercase tracking-widest block mb-3">
                  Rate your experience
                </label>
                <div className="flex items-center gap-2">
                  {RATINGS.map((r) => (
                    <button
                      key={r.score}
                      type="button"
                      title={r.label}
                      onClick={() => setRating(r.score)}
                      className={`flex-1 py-3 rounded-xl border text-2xl transition-all duration-150 ${
                        rating === r.score
                          ? "border-[#00FF88] bg-[rgba(0,255,136,0.12)] scale-110 shadow-[0_0_12px_rgba(0,255,136,0.2)]"
                          : "border-[#2A2A2A] bg-[#0A0A0A] hover:border-[#3A3A3A]"
                      }`}
                    >
                      {r.emoji}
                    </button>
                  ))}
                </div>
                {rating && (
                  <p className="text-xs text-[#00FF88] mt-2 text-center font-mono">
                    {RATINGS.find((r) => r.score === rating)?.label}
                  </p>
                )}
              </div>

              {/* Feedback text */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-[#6B6B6B] uppercase tracking-widest">Tell us more</label>
                <textarea
                  placeholder="What's working? What could be better?"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  required
                  rows={4}
                  className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(0,255,136,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors resize-none"
                />
              </div>

              {/* Email — optional */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-[#6B6B6B] uppercase tracking-widest">
                  Email{" "}
                  <span className="text-[#3A3A3A] normal-case font-normal tracking-normal">(optional — if you&apos;d like a reply)</span>
                </label>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-[#0A0A0A] border border-[#2A2A2A] focus:border-[rgba(0,255,136,0.4)] rounded-lg px-4 py-3 text-sm text-[#F5F5F5] placeholder-[#3A3A3A] outline-none transition-colors"
                />
              </div>

              {status === "error" && (
                <p className="text-xs text-[#EF4444]">Something went wrong. Please try again.</p>
              )}

              <button
                type="submit"
                disabled={status === "loading" || !rating || !feedback.trim()}
                className="w-full bg-[#00FF88] text-[#0A0A0A] font-bold py-3.5 rounded-lg text-sm shadow-[0_0_24px_rgba(0,255,136,0.2)] hover:bg-[#00CC6A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status === "loading" ? "Submitting…" : "Submit feedback →"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
