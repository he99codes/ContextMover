/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Support · ContextMover",
  description: "Get help with ContextMover — FAQ, contact, and documentation.",
};

const FAQ = [
  {
    q: "How do I capture a session?",
    a: "ContextMover captures automatically. Open any supported AI chat and start a conversation — the extension intercepts the API response in the background and saves the session to your local browser storage. No manual action needed.",
  },
  {
    q: "Which AI platforms are supported?",
    a: "Claude (claude.ai), ChatGPT (chatgpt.com / chat.openai.com), Gemini (gemini.google.com), Grok (grok.com / grok.x.ai), Perplexity (perplexity.ai), and DeepSeek (chat.deepseek.com). More platforms are added regularly.",
  },
  {
    q: "Is my data private?",
    a: "Yes. All captured sessions are stored locally in your browser's IndexedDB by default. Nothing leaves your device unless you explicitly connect Google Drive sync or a personal Supabase vault. We never see your conversation content.",
  },
  {
    q: "How do I migrate context to another AI?",
    a: "Open the ContextMover sidebar on any supported platform, find the session you want to migrate, and click Migrate. Choose the target platform and the extension will open it with your context pre-loaded — full history, ready to continue.",
  },
  {
    q: "What is the free tier limit?",
    a: "Free accounts include a monthly allowance for Full Context migrations (Tier 1), Smart Summary migrations (Tier 2), and Attention Engine migrations (Tier 3). You can view your exact remaining quota in the sidebar under the usage meter. Limits reset on the 1st of each month.",
  },
];

export default function SupportPage() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5]">
      <div
        className="mx-auto px-5 sm:px-6 pt-10 sm:pt-20 pb-12 sm:pb-20 w-full"
        style={{ maxWidth: "760px" }}
      >
        <Link
          href="/"
          className="text-[#6B6B6B] hover:text-[#F5F5F5] text-sm transition-colors"
        >
          ← ContextMover
        </Link>

        <h1
          className="mt-6 sm:mt-8 font-bold text-[#F5F5F5]"
          style={{ fontSize: "clamp(22px, 5vw, 28px)", lineHeight: "1.2" }}
        >
          SUPPORT
        </h1>
        <p className="mt-2 text-[#6B6B6B]" style={{ fontSize: "15px" }}>
          Answers to common questions and ways to reach us.
        </p>

        <div
          className="mt-8 sm:mt-12 space-y-8 sm:space-y-10 text-[#F5F5F5]"
          style={{ fontSize: "15px", lineHeight: "1.7" }}
        >
          {/* FAQ */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-5" style={{ fontSize: "17px" }}>
              FREQUENTLY ASKED QUESTIONS
            </h2>
            <div className="space-y-6">
              {FAQ.map(({ q, a }) => (
                <div key={q}>
                  <p className="font-semibold text-[#F5F5F5]">{q}</p>
                  <p className="mt-1 text-[#6B6B6B]">{a}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Contact */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              CONTACT
            </h2>
            <p className="text-[#6B6B6B]">
              For bugs, feature requests, or account questions, email us at{" "}
              <a
                href="mailto:hey@contextmover.com"
                className="text-[#00D26A] hover:underline"
              >
                hey@contextmover.com
              </a>
              . We respond within 24 hours.
            </p>
          </section>

          {/* Legal links */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              LEGAL
            </h2>
            <p className="text-[#6B6B6B]">
              <Link href="/privacy" className="text-[#00D26A] hover:underline">
                Privacy Policy
              </Link>
              {" · "}
              <Link href="/terms" className="text-[#00D26A] hover:underline">
                Terms of Service
              </Link>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
