import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { SettingsView } from "@/components/dashboard/SettingsView";

export default async function SettingsPage() {
  if (!isSupabaseConfigured()) return null;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  return (
    <SettingsView
      email={user.email ?? "(unknown)"}
      userId={user.id}
    />
  );
}
