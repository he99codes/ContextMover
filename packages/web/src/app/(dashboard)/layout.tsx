/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { redirect } from "next/navigation";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { getCachedUser } from "@/lib/supabase/cached";
import { Sidebar } from "@/components/layout/Sidebar";
import { BottomNav } from "@/components/layout/BottomNav";
import { PageTransition } from "@/components/layout/PageTransition";
import { AutoRefresh } from "@/components/layout/AutoRefresh";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isSupabaseConfigured()) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-8">
        <div className="max-w-md text-center">
          <div className="mb-4 text-4xl">⚙️</div>
          <h1 className="text-xl font-semibold text-[#F5F5F5]">
            Supabase not configured
          </h1>
          <p className="mt-2 text-sm text-[#6B6B6B]">
            Create a{" "}
            <code className="rounded-[4px] bg-[#1A1A1A] border border-[#2A2A2A] px-1.5 py-0.5 font-mono text-xs text-[#00FF88]">
              packages/web/.env.local
            </code>{" "}
            file with your Supabase credentials:
          </p>
          <pre className="mt-4 rounded-[8px] border border-[#2A2A2A] bg-[#111111] p-4 text-left text-xs font-mono text-[#F5F5F5]">
            {`NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key`}
          </pre>
          <p className="mt-3 text-xs text-[#6B6B6B]">
            Get these from your Supabase project → Settings → API
          </p>
        </div>
      </div>
    );
  }

  // MM/YY: Use getSession() (cookie-only, no network round-trip) to check
  // if a session exists. If session exists but getUser() returns null (cookie
  // propagation race on fresh login), show a loading state instead of
  // redirecting to /auth — the session will resolve on the next navigation.
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    redirect("/auth");
  }
  const user = await getCachedUser();
  if (!user) {
    // Fix 6: Session cookie exists but getUser() hasn't resolved yet.
    // Show branded loader with auto-refresh — the page will reload after 2s
    // and the session should be resolved by then.
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex flex-col items-center justify-center gap-8">
        {/* Auto-refresh after 2 seconds to retry getUser() */}
        <AutoRefresh delayMs={2000} />
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-12 w-12 animate-spin rounded-full border-2 border-[#1A1A1A] border-t-[#00FF88]" />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-lg font-bold text-[#00FF88]">C</span>
            </div>
          </div>
          <div className="flex flex-col items-center gap-1">
            <h1 className="text-lg font-semibold text-[#F5F5F5] tracking-tight">
              ContextMover
            </h1>
            <p className="text-xs text-[#6B6B6B]">Stay with us…</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#00FF88]" style={{ animationDelay: "0ms" }} />
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#00FF88]" style={{ animationDelay: "150ms" }} />
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#00FF88]" style={{ animationDelay: "300ms" }} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A]">
      <Sidebar user={user} />
      <main className="md:pl-[240px] pt-14 md:pt-0 pb-[60px] md:pb-0">
        <div className="min-h-screen">
          <PageTransition>{children}</PageTransition>
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
