/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { getCachedUser } from "@/lib/supabase/cached";
import { Sidebar } from "@/components/layout/Sidebar";
import { BottomNav } from "@/components/layout/BottomNav";
import { PageTransition } from "@/components/layout/PageTransition";

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

  const user = await getCachedUser();
  if (!user) redirect("/auth");

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
