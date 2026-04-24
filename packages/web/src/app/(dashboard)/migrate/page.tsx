import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { MigrateView } from "@/components/dashboard/MigrateView";
import type { Session } from "@/types";

export default async function MigratePage() {
  if (!isSupabaseConfigured()) return null;

  const supabase = createClient();
  const [{ data: sessionData }, { data: { user } }] = await Promise.all([
    supabase.from("sessions").select("*").order("updated_at", { ascending: false }),
    supabase.auth.getUser(),
  ]);

  return (
    <MigrateView
      initialSessions={(sessionData ?? []) as Session[]}
      userId={user?.id ?? ""}
    />
  );
}
