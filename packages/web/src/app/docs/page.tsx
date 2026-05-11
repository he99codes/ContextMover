import Link from "next/link";
import { BookOpen, Mail } from "lucide-react";

export const metadata = { title: "Docs — ContextMover" };

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5]">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="mb-4">
          <Link href="/" className="text-xs font-mono text-[#6B6B6B] hover:text-[#00FF88] transition-colors">
            ← ContextMover
          </Link>
        </div>
        <div className="flex items-center gap-3 mb-4">
          <BookOpen size={22} className="text-[#00FF88]" />
          <h1 className="text-3xl font-black text-[#F5F5F5]">Documentation</h1>
        </div>
        <p className="text-sm text-[#6B6B6B] mb-12">
          Full documentation is being written. In the meantime, here&apos;s what you need to get started.
        </p>

        <div className="space-y-6">
          {[
            {
              title: "Quick Start",
              body: "Install the Chrome extension, open Claude or ChatGPT, and start chatting. ContextMover captures your session automatically — no setup required.",
            },
            {
              title: "Migrating Context",
              body: "Click the ContextMover extension icon, select a session, choose a target platform, and click Migrate. Your context is injected directly into the target AI's input field.",
            },
            {
              title: "Three Intelligence Tiers",
              body: "Full Context (verbatim), Smart Summary (auto-extracted goals + decisions), or Attention Engine (semantic AI on your device). Choose based on session size.",
            },
            {
              title: "Personal Vault Setup",
              body: "Go to Settings → Personal Vault to connect your own Supabase project. Your sessions sync encrypted to your database — ContextMover never sees the data.",
            },
            {
              title: "IDE Integration",
              body: "Install the ContextMover VS Code extension, enable the bridge server, and your live codebase context is automatically included in migrations.",
            },
          ].map((section) => (
            <div key={section.title} className="rounded-[8px] border border-[#2A2A2A] bg-[#111] p-6">
              <h2 className="text-base font-semibold text-[#F5F5F5] mb-2">{section.title}</h2>
              <p className="text-sm text-[#6B6B6B] leading-relaxed">{section.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col sm:flex-row gap-4">
          <a
            href="mailto:hey@contextmover.app"
            className="flex items-center justify-center gap-2 rounded-[8px] border border-[#2A2A2A] px-5 py-3 text-sm text-[#6B6B6B] hover:border-[#3A3A3A] hover:text-[#F5F5F5] transition-all"
          >
            <Mail size={15} />
            Contact us
          </a>
        </div>
      </div>
    </div>
  );
}
