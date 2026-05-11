import Link from "next/link";
import { Zap, FileCode, Bot, Database, CreditCard, ArrowRight } from "lucide-react";
import { CHROME_STORE_URL } from "@/config/urls";

export const metadata = { title: "Overview — ContextForge" };

const QUICK_LINKS = [
  { label: "Prompt Templates",   desc: "Manage your reusable prompts",      href: "/settings/prompts", icon: FileCode },
  { label: "Agents",             desc: "Configure custom AI agents",        href: "/settings/agents",  icon: Bot },
  { label: "Personal Vault",     desc: "Connect your Supabase vault",       href: "/settings/vault",   icon: Database },
  { label: "Upgrade Plan",       desc: "Unlock Attention Engine + more",    href: "/pricing",           icon: CreditCard },
];

export default function OverviewPage() {
  return (
    <div className="max-w-3xl mx-auto p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-[#F5F5F5]">Overview</h1>
        <p className="mt-1 text-sm text-[#6B6B6B]">Your ContextForge account at a glance.</p>
      </div>

      {/* Extension CTA */}
      <div className="rounded-[10px] border border-[rgba(0,255,136,0.2)] bg-[rgba(0,255,136,0.04)] p-6 mb-6 flex flex-col sm:flex-row items-start sm:items-center gap-5">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[8px] bg-[#00FF88]/10 border border-[#00FF88]/20">
          <Zap size={20} className="text-[#00FF88]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[#F5F5F5]">Sessions live in the extension</p>
          <p className="text-xs text-[#6B6B6B] mt-1 leading-relaxed">
            Your captured conversations are stored locally in the Chrome extension — never on our servers.
            Open the extension sidebar to browse, migrate, and manage your sessions.
          </p>
        </div>
        <a
          href={CHROME_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-[6px] bg-[#00FF88] px-4 py-2 text-xs font-semibold text-black hover:bg-[#00CC6A] transition-colors"
        >
          Open extension <ArrowRight size={12} />
        </a>
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {QUICK_LINKS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="group flex items-center gap-4 rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-4 hover:border-[rgba(0,255,136,0.3)] hover:bg-[#0D1A0D] transition-all"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] border border-[#2A2A2A] bg-[#111] group-hover:border-[#00FF88]/20 transition-colors">
              <item.icon size={15} className="text-[#6B6B6B] group-hover:text-[#00FF88] transition-colors" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-[#F5F5F5]">{item.label}</p>
              <p className="text-xs text-[#6B6B6B] mt-0.5">{item.desc}</p>
            </div>
            <ArrowRight size={14} className="text-[#3A3A3A] group-hover:text-[#00FF88] shrink-0 transition-colors" />
          </Link>
        ))}
      </div>
    </div>
  );
}
