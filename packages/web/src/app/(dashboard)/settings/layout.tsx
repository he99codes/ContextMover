"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SETTINGS_TABS = [
  { label: "General",         href: "/settings",         exact: true },
  { label: "Personal Vault",  href: "/settings/vault",   exact: false },
  { label: "Agents",          href: "/settings/agents",  exact: false },
  { label: "Prompts",         href: "/settings/prompts", exact: false },
  { label: "Billing",         href: "/pricing",          exact: false },
] as const;

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col min-h-screen">
      <div className="shrink-0 border-b border-[#2A2A2A] bg-[#0A0A0A] px-4 sm:px-8 pt-4 sm:pt-6 pb-0">
        <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-[#3A3A3A] mb-2 sm:mb-3">
          Settings
        </p>
        <nav className="flex gap-0 overflow-x-auto no-scrollbar" aria-label="Settings sections">
          {SETTINGS_TABS.map((tab) => {
            const isActive = tab.exact
              ? pathname === tab.href
              : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={[
                  "relative shrink-0 px-3 sm:px-4 pb-3 pt-0.5 text-sm font-medium transition-colors duration-150 -mb-px min-h-[44px] flex items-end",
                  isActive
                    ? "text-[#00FF88] border-b-2 border-[#00FF88]"
                    : "text-[#6B6B6B] border-b-2 border-transparent hover:text-[#F5F5F5]",
                ].join(" ")}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}
