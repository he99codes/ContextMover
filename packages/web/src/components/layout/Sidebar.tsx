"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  ArrowLeftRight,
  Bot,
  BarChart3,
  Settings,
  LogOut,
  Zap,
  FileCode,
  Database,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { createClient } from "@/lib/supabase/client";

const navigation = [
  { name: "Sessions",  href: "/dashboard",        icon: LayoutDashboard },
  { name: "Migrate",   href: "/migrate",           icon: ArrowLeftRight },
  { name: "Agents",    href: "/agents",            icon: Bot },
  { name: "Analytics", href: "/analytics",         icon: BarChart3 },
  { name: "Prompts",   href: "/settings/prompts",  icon: FileCode },
  { name: "Vault",     href: "/settings/vault",    icon: Database },
  { name: "Settings",  href: "/settings",          icon: Settings },
];

interface SidebarProps {
  user: {
    id: string;
    email?: string;
  } | null;
}

export function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/auth");
    router.refresh();
  };

  const initials = user?.email
    ? user.email.slice(0, 2).toUpperCase()
    : "CF";

  return (
    <aside className="fixed inset-y-0 left-0 z-50 flex w-[240px] flex-col border-r border-[#2A2A2A] bg-[#0A0A0A]">
      {/* Logo */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-[#2A2A2A] px-4">
        <div className="relative flex h-7 w-7 items-center justify-center rounded-[6px] bg-[#00FF88]">
          <Zap size={14} className="text-black" />
          <span className="animate-pulse-green absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#00FF88]" />
        </div>
        <span className="text-[15px] font-semibold text-[#F5F5F5] tracking-tight">
          ContextForge
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {navigation.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" &&
              pathname.startsWith(item.href + "/") &&
              !navigation.some(
                (other) =>
                  other.href !== item.href &&
                  other.href.length > item.href.length &&
                  pathname.startsWith(other.href)
              ));

          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "group relative flex h-10 items-center gap-2.5 overflow-hidden rounded-[8px] px-3 text-sm font-medium transition-all duration-150",
                isActive
                  ? "bg-[#1A1A1A] text-[#00FF88]"
                  : "text-[#6B6B6B] hover:bg-[#111111] hover:text-[#F5F5F5]"
              )}
            >
              {/* sliding left border */}
              <span
                className={cn(
                  "absolute inset-y-0 left-0 w-[2px] rounded-r-full bg-[#00FF88] transition-all duration-200",
                  isActive ? "opacity-100 scale-y-100" : "opacity-0 scale-y-0 group-hover:opacity-40 group-hover:scale-y-75"
                )}
              />
              <item.icon
                size={16}
                className={cn(
                  "shrink-0 transition-colors duration-150",
                  isActive ? "text-[#00FF88]" : "text-[#6B6B6B] group-hover:text-[#F5F5F5]"
                )}
              />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      <div className="shrink-0 border-t border-[#2A2A2A] p-3">
        <div className="flex items-center gap-2.5 rounded-[8px] px-2 py-2 transition-colors hover:bg-[#111111]">
          <Avatar className="h-7 w-7 shrink-0">
            <AvatarFallback className="bg-[#00FF88]/10 text-[#00FF88] text-xs font-semibold border border-[#00FF88]/20">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium text-[#6B6B6B]">
              {user?.email ?? ""}
            </p>
          </div>
          <button
            onClick={handleSignOut}
            className="shrink-0 rounded-[4px] p-1 text-[#6B6B6B] transition-colors hover:bg-red-500/10 hover:text-red-400"
            title="Sign out"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
