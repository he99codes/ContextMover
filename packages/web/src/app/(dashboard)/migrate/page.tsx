import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { getCachedUser } from "@/lib/supabase/cached";
import { MigrateView } from "@/components/dashboard/MigrateView";
import type { Session } from "@/types";

export default async function MigratePage() {
  if (!isSupabaseConfigured()) return null;

  const [supabase, user] = [createClient(), await getCachedUser()];
  const { data: sessionData } = await supabase
    .from("sessions")
    .select("id, title, platform, updated_at, created_at, messages")
    .order("updated_at", { ascending: false });

  return (
    <MigrateView
      initialSessions={(sessionData ?? []) as Session[]}
      userId={user?.id ?? ""}
    />
  );
}
