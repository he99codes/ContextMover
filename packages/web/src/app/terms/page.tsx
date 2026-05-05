import Link from "next/link";

export const metadata = { title: "Terms of Service — ContextForge" };

const LAST_UPDATED = "May 2026";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5]">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="mb-4">
          <Link href="/" className="text-xs font-mono text-[#6B6B6B] hover:text-[#00FF88] transition-colors">
            ← ContextForge
          </Link>
        </div>
        <h1 className="text-3xl font-black text-[#F5F5F5] mb-2">Terms of Service</h1>
        <p className="text-sm text-[#6B6B6B] mb-12">Last updated: {LAST_UPDATED}</p>

        <div className="space-y-8 text-sm text-[#B0B0B0] leading-relaxed">
          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">1. Acceptance</h2>
            <p>By installing the ContextForge browser extension or using the ContextForge web application, you agree to these Terms. If you do not agree, do not use the service.</p>
          </section>
          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">2. Description of Service</h2>
            <p>ContextForge is a browser extension and web application that captures AI conversations locally in your browser and enables context migration between AI platforms. The service operates on a zero-knowledge architecture — your conversation content never reaches ContextForge servers.</p>
          </section>
          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">3. Free and Paid Plans</h2>
            <p>ContextForge offers a free tier with limited features and paid plans with expanded capabilities. Paid plans are billed monthly or annually. You may cancel at any time. No refunds for partial billing periods.</p>
          </section>
          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">4. Acceptable Use</h2>
            <p>You may not use ContextForge to violate the terms of service of any third-party AI platform. You are solely responsible for the content of your AI conversations. ContextForge is not liable for how third-party platforms respond to migrated context.</p>
          </section>
          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">5. Intellectual Property</h2>
            <p>The ContextForge software, design, and trademarks are owned by ContextForge. Your conversation data remains yours — we have no rights to it, and it is not transmitted to our servers.</p>
          </section>
          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">6. Disclaimer of Warranties</h2>
            <p>ContextForge is provided &ldquo;as is&rdquo; without warranty of any kind. We do not guarantee uninterrupted service, perfect accuracy of context extraction, or compatibility with all AI platforms at all times.</p>
          </section>
          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">7. Limitation of Liability</h2>
            <p>ContextForge shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the service, including but not limited to loss of data or business interruption.</p>
          </section>
          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">8. Changes to Terms</h2>
            <p>We may update these Terms at any time. Continued use of ContextForge after changes constitutes acceptance. We will notify registered users via email of material changes.</p>
          </section>
          <section>
            <h2 className="mb-3 text-base font-semibold text-[#F5F5F5]">9. Contact</h2>
            <p>Questions? <a href="mailto:hey@contextforge.app" className="text-[#00FF88] hover:underline">hey@contextforge.app</a></p>
          </section>
        </div>
      </div>
    </div>
  );
}
