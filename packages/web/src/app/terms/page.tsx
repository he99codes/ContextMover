import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service · ContextMover",
  description: "ContextMover Terms of Service — Last updated May 11, 2026",
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5]">
      <div
        className="mx-auto px-6"
        style={{ maxWidth: "760px", paddingTop: "80px", paddingBottom: "80px" }}
      >
        <Link
          href="/"
          className="text-[#6B6B6B] hover:text-[#F5F5F5] text-sm transition-colors"
        >
          ← ContextMover
        </Link>

        <h1
          className="mt-8 font-bold text-[#F5F5F5]"
          style={{ fontSize: "28px", lineHeight: "1.2" }}
        >
          TERMS OF SERVICE
        </h1>
        <p className="mt-2 text-[#6B6B6B]" style={{ fontSize: "15px" }}>
          Last updated: May 11, 2026
        </p>

        <div
          className="mt-12 space-y-10 text-[#F5F5F5]"
          style={{ fontSize: "15px", lineHeight: "1.8" }}
        >
          {/* 1 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              1. ACCEPTANCE
            </h2>
            <p className="text-[#6B6B6B]">
              By installing ContextMover or using contextmover.com you agree to these terms. If you
              disagree, do not use ContextMover.
            </p>
          </section>

          {/* 2 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              2. WHAT CONTEXTMOVER IS
            </h2>
            <p className="text-[#6B6B6B] mb-3">
              ContextMover is a browser extension and web app that:
            </p>
            <ul className="text-[#6B6B6B] space-y-1 mb-4" style={{ paddingLeft: "20px" }}>
              <li>Captures your AI chat sessions locally</li>
              <li>Compresses and migrates context across AI platforms</li>
              <li>Operates entirely on your device</li>
            </ul>
            <p className="text-[#6B6B6B]">
              ContextMover is a tool for personal productivity. It is not affiliated with Anthropic,
              OpenAI, Google, xAI, DeepSeek, or Perplexity.
            </p>
          </section>

          {/* 3 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-4" style={{ fontSize: "17px" }}>
              3. YOUR DATA OWNERSHIP
            </h2>
            <div className="space-y-3 text-[#6B6B6B]">
              <p>
                <span className="text-[#F5F5F5] font-semibold">3.1</span> All conversation data,
                session content, and context generated through ContextMover belongs exclusively to
                you.
              </p>
              <p>
                <span className="text-[#F5F5F5] font-semibold">3.2</span> ContextMover processes
                conversation content locally on your device only. We do not process, store, or
                access your conversation content on our servers.
              </p>
              <p>
                <span className="text-[#F5F5F5] font-semibold">3.3</span> You may export or delete
                all your data at any time through Settings.
              </p>
              <p>
                <span className="text-[#F5F5F5] font-semibold">3.4</span> ContextMover will never
                sell, share, or monetize your conversation data.
              </p>
            </div>
          </section>

          {/* 4 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-4" style={{ fontSize: "17px" }}>
              4. ACCEPTABLE USE
            </h2>
            <p className="text-[#6B6B6B] mb-3">You may use ContextMover to:</p>
            <ul className="text-[#6B6B6B] space-y-1 mb-5" style={{ paddingLeft: "20px" }}>
              <li>&#x2713;&nbsp; Migrate your own AI conversations</li>
              <li>&#x2713;&nbsp; Export your own session data</li>
              <li>&#x2713;&nbsp; Integrate with your own development tools</li>
            </ul>
            <p className="text-[#6B6B6B] mb-3">You may NOT use ContextMover to:</p>
            <ul className="text-[#6B6B6B] space-y-1" style={{ paddingLeft: "20px" }}>
              <li>&#x2717;&nbsp; Scrape or collect other users&apos; data</li>
              <li>&#x2717;&nbsp; Bypass AI platform security measures</li>
              <li>&#x2717;&nbsp; Violate any AI platform&apos;s terms of service</li>
              <li>&#x2717;&nbsp; Automate actions without human oversight</li>
              <li>&#x2717;&nbsp; Resell or redistribute the extension</li>
              <li>&#x2717;&nbsp; Reverse engineer the extension</li>
            </ul>
          </section>

          {/* 5 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-4" style={{ fontSize: "17px" }}>
              5. SUBSCRIPTION AND PAYMENTS
            </h2>
            <div className="space-y-6 text-[#6B6B6B]">
              <div>
                <p className="font-semibold text-[#F5F5F5] mb-2">5.1 Free Tier</p>
                <p className="mb-2">
                  ContextMover offers a free tier with these limits:
                </p>
                <ul className="space-y-1" style={{ paddingLeft: "20px" }}>
                  <li>50 Full Context migrations per month</li>
                  <li>50 Smart Summary migrations per month</li>
                  <li>10 Attention Engine migrations per month</li>
                  <li>10 sessions stored locally</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-[#F5F5F5] mb-2">5.2 Pro Tier</p>
                <p>
                  Pro subscription removes all limits. Billed monthly. Cancel anytime.
                  <br />
                  India: ₹199/month via Razorpay
                  <br />
                  Global: $5/month via Stripe
                </p>
              </div>
              <div>
                <p className="font-semibold text-[#F5F5F5] mb-2">5.3 Billing</p>
                <p>
                  Subscriptions renew automatically. You will receive a reminder before renewal.
                  Cancel anytime from Settings &rarr; Billing.
                </p>
              </div>
              <div>
                <p className="font-semibold text-[#F5F5F5] mb-2">5.4 Refunds</p>
                <p>
                  We offer a 14-day free trial on Pro. After the trial, refunds are at our
                  discretion. Contact{" "}
                  <a
                    href="mailto:priyanshu@contextmover.com"
                    className="text-[#00D26A] hover:underline"
                  >
                    priyanshu@contextmover.com
                  </a>{" "}
                  for refund requests within 7 days of charge.
                </p>
              </div>
              <div>
                <p className="font-semibold text-[#F5F5F5] mb-2">5.5 Price Changes</p>
                <p>
                  We will notify you 30 days before price changes via email. You may cancel before
                  changes take effect.
                </p>
              </div>
            </div>
          </section>

          {/* 6 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-4" style={{ fontSize: "17px" }}>
              6. INTELLECTUAL PROPERTY
            </h2>
            <div className="space-y-3 text-[#6B6B6B]">
              <p>
                <span className="text-[#F5F5F5] font-semibold">6.1</span> ContextMover, its logo,
                and all software are owned by Priyanshu Sharma.
              </p>
              <p>
                <span className="text-[#F5F5F5] font-semibold">6.2</span> You are granted a
                limited, non-exclusive, non-transferable license to use ContextMover for personal or
                professional use.
              </p>
              <p>
                <span className="text-[#F5F5F5] font-semibold">6.3</span> You may not copy, modify,
                distribute, or create derivative works of ContextMover.
              </p>
            </div>
          </section>

          {/* 7 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              7. THIRD PARTY PLATFORMS
            </h2>
            <p className="text-[#6B6B6B] mb-4">
              ContextMover integrates with third-party AI platforms (Claude, ChatGPT, Gemini, etc.).
            </p>
            <div className="space-y-3 text-[#6B6B6B]">
              <p>
                <span className="text-[#F5F5F5] font-semibold">7.1</span> We are not responsible
                for changes these platforms make to their interfaces that may affect ContextMover&apos;s
                functionality.
              </p>
              <p>
                <span className="text-[#F5F5F5] font-semibold">7.2</span> You are responsible for
                complying with each platform&apos;s terms of service when using ContextMover with their
                services.
              </p>
              <p>
                <span className="text-[#F5F5F5] font-semibold">7.3</span> ContextMover is an
                independent product not endorsed by any AI platform.
              </p>
            </div>
          </section>

          {/* 8 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              8. DISCLAIMER OF WARRANTIES
            </h2>
            <p className="text-[#6B6B6B] mb-3">
              ContextMover is provided &ldquo;as is&rdquo; without warranty of any kind.
            </p>
            <p className="text-[#6B6B6B] mb-2">We do not warrant that:</p>
            <ul className="text-[#6B6B6B] space-y-1 mb-4" style={{ paddingLeft: "20px" }}>
              <li>The service will be uninterrupted</li>
              <li>The service will be error-free</li>
              <li>Captured context will be 100% accurate</li>
              <li>All AI platforms will remain compatible</li>
            </ul>
            <p className="text-[#6B6B6B]">
              <span className="text-[#F5F5F5] font-semibold">8.1 AI Platform Compatibility</span>
              <br />
              AI platforms may update their interfaces at any time. We work to maintain
              compatibility but cannot guarantee it at all times.
            </p>
          </section>

          {/* 9 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              9. LIMITATION OF LIABILITY
            </h2>
            <p className="text-[#6B6B6B] mb-3">
              To the maximum extent permitted by law, ContextMover&apos;s liability is limited to the
              amount you paid in the last 3 months.
            </p>
            <p className="text-[#6B6B6B] mb-2">We are not liable for:</p>
            <ul className="text-[#6B6B6B] space-y-1" style={{ paddingLeft: "20px" }}>
              <li>Loss of data</li>
              <li>Loss of business</li>
              <li>Indirect or consequential damages</li>
              <li>AI platform policy violations</li>
            </ul>
          </section>

          {/* 10 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-4" style={{ fontSize: "17px" }}>
              10. TERMINATION
            </h2>
            <div className="space-y-3 text-[#6B6B6B]">
              <p>
                <span className="text-[#F5F5F5] font-semibold">10.1</span> You may stop using
                ContextMover and delete your account at any time.
              </p>
              <p>
                <span className="text-[#F5F5F5] font-semibold">10.2</span> We may suspend accounts
                that violate these terms with reasonable notice.
              </p>
              <p>
                <span className="text-[#F5F5F5] font-semibold">10.3</span> On termination, your
                local data remains on your device. We delete your account data within 30 days.
              </p>
            </div>
          </section>

          {/* 11 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              11. CHANGES TO TERMS
            </h2>
            <p className="text-[#6B6B6B]">
              We will notify you of material changes via email 14 days before they take effect.
              Continued use = acceptance of new terms.
            </p>
          </section>

          {/* 12 */}
          <section>
            <h2 className="font-bold text-[#F5F5F5] mb-3" style={{ fontSize: "17px" }}>
              12. GOVERNING LAW
            </h2>
            <p className="text-[#6B6B6B]">
              These terms are governed by Indian law. Disputes subject to courts in Pune,
              Maharashtra, India.
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
              <a href="mailto:priyanshu@contextmover.com" className="text-[#00D26A] hover:underline">
                priyanshu@contextmover.com
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
          className="mt-16 pt-6 border-t border-[#1A1A1A] flex gap-6 text-[#6B6B6B]"
          style={{ fontSize: "13px" }}
        >
          <Link href="/" className="hover:text-[#F5F5F5] transition-colors">
            Home
          </Link>
          <Link href="/privacy" className="hover:text-[#F5F5F5] transition-colors">
            Privacy Policy
          </Link>
        </div>
      </div>
    </div>
  );
}
