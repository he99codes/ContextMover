import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { SettingsView } from "@/components/dashboard/SettingsView";

export default async function SettingsPage() {
  if (!isSupabaseConfigured()) return null;
  const supabase = createClient();

  const [{ data: { user } }, { count }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from("sessions").select("id", { count: "exact", head: true }),
  ]);

  if (!user) return null;

  return (
    <SettingsView
      email={user.email ?? "(unknown)"}
      userId={user.id}
      sessionCount={count ?? 0}
    />
  );
}
