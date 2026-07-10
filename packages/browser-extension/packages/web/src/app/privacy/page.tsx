/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy · ContextMover",
  description: "ContextMover Privacy Policy — Last updated May 11, 2026",
};

export default function PrivacyPage() {
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
          PRIVACY POLICY
        </h1>
        <p className="mt-2 text-[#6B6B6B]" style={{ fontSize: "15px" }}>
          Last updated: May 11, 2026
        </p>

        <div
          className="mt-8 sm:mt-12 space-y-8 sm:space-y-10 text-[#F5F5F5]"
          style={{ fontSize: "15px", lineHeight: "1.7" }}
        >
          {/* 1 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              1. WHO WE ARE
            </h2>
            <p className="text-[#6B6B6B]">
              ContextMover (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) is operated by Priyanshu Sharma, a sole
              proprietorship registered under Udyam (MSME), Pune, Maharashtra, India.
            </p>
            <p className="text-[#6B6B6B] mt-3">
              Contact:{" "}
              <a href="mailto:hey@contextmover.com" className="text-[#00D26A] hover:underline">
                hey@contextmover.com
              </a>
              <br />
              Website:{" "}
              <a href="https://contextmover.com" className="text-[#00D26A] hover:underline">
                https://contextmover.com
              </a>
            </p>
          </section>

          {/* 2 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              2. THE SHORT VERSION
            </h2>
            <p className="text-[#6B6B6B]">
              Your AI conversations never touch our servers. Ever. We built it this way on purpose.
            </p>
          </section>

          {/* 3 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-4" style={{ fontSize: "17px" }}>
              3. WHAT WE COLLECT
            </h2>
            <p className="font-semibold text-[#F5F5F5] mb-2">3.1 What we DO collect:</p>
            <ul className="text-[#6B6B6B] space-y-1 mb-6" style={{ paddingLeft: "20px" }}>
              <li>Email address (when you create an account)</li>
              <li>Subscription status (free or pro)</li>
              <li>
                Usage counts (number of migrations per month)
                <br />
                <span className="text-[#6B6B6B]">&mdash; no content, just numbers</span>
              </li>
              <li>Payment records (via Razorpay)</li>
              <li>
                Anonymous analytics (page views, feature usage)
                <br />
                <span className="text-[#6B6B6B]">&mdash; no personal identifiers</span>
              </li>
            </ul>
            <p className="font-semibold text-[#F5F5F5] mb-2">3.2 What we DO NOT collect:</p>
            <ul className="text-[#6B6B6B] space-y-1" style={{ paddingLeft: "20px" }}>
              <li>Your AI conversation content</li>
              <li>Your chat messages</li>
              <li>Your code</li>
              <li>Your session data</li>
              <li>Any content you generate with AI tools</li>
            </ul>
          </section>

          {/* 4 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              4. HOW YOUR DATA STAYS ON YOUR DEVICE
            </h2>
            <p className="text-[#6B6B6B] mb-3">
              ContextMover uses a zero-knowledge architecture:
            </p>
            <ul className="text-[#6B6B6B] space-y-3" style={{ paddingLeft: "20px" }}>
              <li>
                All AI sessions captured by the extension are stored in your browser&apos;s local
                storage (IndexedDB) on your device only.
              </li>
              <li>
                If you use the MCP desktop bridge, sessions are also stored in a plaintext SQLite
                database at <code>~/.contextmover/sessions.db</code>. This file is protected by
                your operating system&apos;s user permissions. ContextMover servers never receive
                your conversation content.
              </li>
              <li>
                Optional: if you connect Google Drive, your captured sessions are stored in a
                private app-data folder in your own Google Drive account. ContextMover servers do
                not receive this data — it travels directly from your browser to Google. You can
                disconnect Google Drive at any time from the Sync panel, which stops all future
                uploads. Disconnecting does not delete data already in your Drive.
              </li>
              <li>
                When you click Migrate, your context is processed entirely on your device and
                injected directly into the target AI platform. It never passes through our servers.
              </li>
              <li>
                If you choose to connect a Personal Vault (optional), your data syncs to YOUR OWN
                Supabase account. ContextMover has no access to this data.
              </li>
              <li>
                We cannot read your conversations even if legally compelled to do so, because we
                technically do not have them.
              </li>
            </ul>
            <p className="text-[#6B6B6B] mt-4">
              ContextMover accesses your AI conversations by reading network responses in your
              browser — the same data your browser already receives when you use these platforms.
              This is equivalent to using your browser&apos;s built-in developer tools. ContextMover
              never sends requests to AI platforms on your behalf, never modifies your
              conversations, and never accesses any data you are not already authorized to see.
            </p>
          </section>

          {/* 5 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              5. CHROME EXTENSION PERMISSIONS
            </h2>
            <p className="text-[#6B6B6B] mb-4">ContextMover requests these permissions:</p>
            <div className="space-y-2 mb-4">
              {[
                ["activeTab", "to capture the current AI chat page"],
                ["storage", "to save sessions locally on your device"],
                ["scripting", "to inject migrated context into target"],
                ["sidePanel", "to show the extension sidebar"],
                ["downloads", "to export sessions as files"],
              ].map(([perm, desc]) => (
                <div key={perm} className="flex gap-3">
                  <span className="text-[#F5F5F5] font-mono shrink-0" style={{ fontSize: "14px" }}>
                    {perm}
                  </span>
                  <span className="text-[#6B6B6B]">&mdash; {desc}</span>
                </div>
              ))}
            </div>
            <p className="text-[#6B6B6B]">
              We do not use these permissions to collect or transmit your data to our servers.
            </p>
          </section>

          {/* 6 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              6. COOKIES AND TRACKING
            </h2>
            <p className="text-[#6B6B6B] mb-2">We use minimal cookies for:</p>
            <ul className="text-[#6B6B6B] space-y-1 mb-4" style={{ paddingLeft: "20px" }}>
              <li>Keeping you logged in (session cookie)</li>
              <li>Remembering your region for pricing display</li>
            </ul>
            <p className="text-[#6B6B6B]">
              We do not use advertising cookies.
              <br />
              We do not sell your data to advertisers.
              <br />
              We do not use third-party tracking pixels.
            </p>
          </section>

          {/* 7 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-4" style={{ fontSize: "17px" }}>
              7. THIRD PARTY SERVICES
            </h2>
            <p className="text-[#6B6B6B] mb-4">We use these third parties:</p>
            <div className="space-y-5">
              {[
                {
                  name: "Supabase (supabase.com)",
                  lines: [
                    "Stores your account and subscription status",
                    "Privacy policy: supabase.com/privacy",
                  ],
                },
                {
                  name: "Razorpay (razorpay.com)",
                  lines: [
                    "Processes all payments globally",
                    "Privacy policy: razorpay.com/privacy",
                  ],
                },
                {
                  name: "ipapi.co",
                  lines: [
                    "Detects your country for pricing display",
                    "No personal data stored",
                    "Privacy policy: ipapi.co/privacy",
                  ],
                },
              ].map(({ name, lines }) => (
                <div key={name}>
                  <p className="font-semibold text-[#F5F5F5] mb-1">{name}</p>
                  {lines.map((l) => (
                    <p key={l} className="text-[#6B6B6B]">
                      &rarr; {l}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </section>

          {/* 8 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              8. YOUR RIGHTS
            </h2>
            <p className="text-[#6B6B6B] mb-2">You have the right to:</p>
            <ul className="text-[#6B6B6B] space-y-1 mb-4" style={{ paddingLeft: "20px" }}>
              <li>Access all data we hold about you</li>
              <li>Export your data at any time</li>
              <li>Delete your account and all associated data</li>
              <li>Correct any inaccurate information</li>
            </ul>
            <p className="text-[#6B6B6B]">
              To exercise these rights:
              <br />
              Email{" "}
              <a href="mailto:hey@contextmover.com" className="text-[#00D26A] hover:underline">
                hey@contextmover.com
              </a>
              <br />
              We respond within 7 business days.
            </p>
          </section>

          {/* 9 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              9. DATA DELETION
            </h2>
            <p className="text-[#6B6B6B] mb-3">
              To delete your account:
              <br />
              Settings &rarr; Delete Account &rarr; Confirm
            </p>
            <p className="text-[#6B6B6B] mb-2">This permanently deletes:</p>
            <ul className="text-[#6B6B6B] space-y-1 mb-4" style={{ paddingLeft: "20px" }}>
              <li>Your email and account</li>
              <li>Your subscription record</li>
              <li>Your usage history</li>
              <li>Your payment history</li>
            </ul>
            <p className="text-[#6B6B6B]">
              It does NOT delete data in your Personal Vault (if connected) &mdash; that is your own
              Supabase account which you control independently.
            </p>
          </section>

          {/* 10 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              10. CHILDREN&apos;S PRIVACY
            </h2>
            <p className="text-[#6B6B6B]">
              ContextMover is not directed at children under 13. We do not knowingly collect data
              from children. If you believe a child has provided us data, contact{" "}
              <a href="mailto:hey@contextmover.com" className="text-[#00D26A] hover:underline">
                hey@contextmover.com
              </a>{" "}
              immediately.
            </p>
          </section>

          {/* 11 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              11. CHANGES TO THIS POLICY
            </h2>
            <p className="text-[#6B6B6B] mb-2">
              We will notify you of significant changes via:
            </p>
            <ul className="text-[#6B6B6B] space-y-1 mb-3" style={{ paddingLeft: "20px" }}>
              <li>Email to your registered address</li>
              <li>Banner on contextmover.com</li>
            </ul>
            <p className="text-[#6B6B6B]">Continued use after changes = acceptance.</p>
          </section>

          {/* 12 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              12. GOVERNING LAW
            </h2>
            <p className="text-[#6B6B6B]">
              This policy is governed by the laws of India. Disputes are subject to jurisdiction of
              courts in Pune, Maharashtra, India.
            </p>
          </section>

          {/* 13 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              13. CONTACT
            </h2>
            <p className="text-[#6B6B6B]">
              Priyanshu Sharma
              <br />
              ContextMover
              <br />
              Pune, Maharashtra, India
              <br />
              <a href="mailto:hey@contextmover.com" className="text-[#00D26A] hover:underline">
                hey@contextmover.com
              </a>
              <br />
              <a href="https://contextmover.com" className="text-[#00D26A] hover:underline">
                https://contextmover.com
              </a>
            </p>
          </section>
        </div>

        {/* Footer nav */}
        <div
          className="mt-12 sm:mt-16 pt-6 border-t border-[#1A1A1A] flex flex-wrap gap-1 sm:gap-6 text-[#6B6B6B]"
          style={{ fontSize: "14px" }}
        >
          <Link href="/" className="hover:text-[#F5F5F5] transition-colors flex items-center min-h-[44px] pr-4">
            Home
          </Link>
          <Link href="/terms" className="hover:text-[#F5F5F5] transition-colors flex items-center min-h-[44px] pr-4">
            Terms of Service
          </Link>
        </div>
      </div>
    </div>
  );
}
