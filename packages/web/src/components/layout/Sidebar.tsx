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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { createClient } from "@/lib/supabase/client";

const navigation = [
  { name: "Sessions", href: "/dashboard", icon: LayoutDashboard },
  { name: "Migrate", href: "/migrate", icon: ArrowLeftRight },
  { name: "Agents", href: "/agents", icon: Bot },
  { name: "Analytics", href: "/analytics", icon: BarChart3 },
  { name: "Settings", href: "/settings", icon: Settings },
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
    <aside className="fixed inset-y-0 left-0 z-50 flex w-[220px] flex-col border-r border-[#E8E8E4] bg-white">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2.5 border-b border-[#E8E8E4] px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#2563EB]">
          <Zap size={14} className="text-white" />
        </div>
        <span className="text-[15px] font-semibold text-[#1A1A1A] tracking-tight">
          ContextForge
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {navigation.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));

          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-[#EFF6FF] text-[#2563EB]"
                  : "text-[#6B6B6B] hover:bg-[#F7F7F5] hover:text-[#1A1A1A]"
              )}
            >
              <item.icon
                size={16}
                className={isActive ? "text-[#2563EB]" : "text-[#6B6B6B]"}
              />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* User */}
      <div className="border-t border-[#E8E8E4] p-3">
        <div className="flex items-center gap-2.5 rounded-md px-2 py-2">
          <Avatar className="h-7 w-7">
            <AvatarFallback className="bg-[#EFF6FF] text-[#2563EB] text-xs font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium text-[#1A1A1A]">
              {user?.email ?? ""}
            </p>
          </div>
          <button
            onClick={handleSignOut}
            className="shrink-0 text-[#6B6B6B] transition-colors hover:text-[#1A1A1A]"
            title="Sign out"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
