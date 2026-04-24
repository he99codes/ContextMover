import { redirect } from "next/navigation";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { Sidebar } from "@/components/layout/Sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isSupabaseConfigured()) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F7F7F5] p-8">
        <div className="max-w-md text-center">
          <div className="mb-4 text-4xl">⚙️</div>
          <h1 className="text-xl font-semibold text-[#1A1A1A]">
            Supabase not configured
          </h1>
          <p className="mt-2 text-sm text-[#6B6B6B]">
            Create a{" "}
            <code className="rounded bg-[#F7F7F5] px-1.5 py-0.5 font-mono text-xs text-[#1A1A1A]">
              packages/web/.env.local
            </code>{" "}
            file with your Supabase credentials:
          </p>
          <pre className="mt-4 rounded-xl border border-[#E8E8E4] bg-white p-4 text-left text-xs font-mono text-[#1A1A1A]">
            {`NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key`}
          </pre>
          <p className="mt-3 text-xs text-[#6B6B6B]">
            Get these from your Supabase project → Settings → API
          </p>
        </div>
      </div>
    );
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth");
  }

  return (
    <div className="min-h-screen bg-[#F7F7F5]">
      <Sidebar user={user} />
      <main className="pl-[220px]">
        <div className="min-h-screen">{children}</div>
      </main>
    </div>
  );
}
