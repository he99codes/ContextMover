"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Bot, Settings, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { name: "Overview",  href: "/analytics",  icon: BarChart3 },
  { name: "Agents",    href: "/settings/agents",  icon: Bot },
  { name: "Pricing",   href: "/pricing",     icon: CreditCard },
  { name: "Settings",  href: "/settings",    icon: Settings },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0A0A0A] border-t border-[#2A2A2A] flex items-stretch" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      {TABS.map((tab) => {
        const isActive =
          tab.href === "/settings"
            ? pathname === "/settings"
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.name}
            href={tab.href}
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[60px] text-[10px] font-medium transition-colors active:opacity-70",
              isActive ? "text-[#00FF88]" : "text-[#6B6B6B]"
            )}
          >
            <tab.icon size={20} strokeWidth={isActive ? 2.5 : 1.8} />
            <span>{tab.name}</span>
          </Link>
        );
      })}
    </nav>
  );
}
