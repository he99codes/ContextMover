import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { SessionList } from "@/components/dashboard/SessionList";
import type { Session } from "@/types";

export default async function DashboardPage() {
  if (!isSupabaseConfigured()) return null;

  const supabase = createClient();

  const [{ data: sessionData }, { data: { user } }] = await Promise.all([
    supabase.from("sessions").select("*").order("updated_at", { ascending: false }),
    supabase.auth.getUser(),
  ]);

  const sessions = (sessionData ?? []) as Session[];

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[#F5F5F5]">Sessions</h1>
        <p className="mt-1 text-sm text-[#6B6B6B]">
          {sessions.length > 0
            ? `${sessions.length} captured session${sessions.length === 1 ? "" : "s"}`
            : "Waiting for sessions from the extension"}
        </p>
      </div>

      <SessionList
        initialSessions={sessions}
        userId={user?.id ?? ""}
      />
    </div>
  );
}
