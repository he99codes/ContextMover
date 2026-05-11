import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { AgentsView } from "@/components/dashboard/AgentsView";
import type { CustomAgent } from "@/types";

export default async function AgentsPage() {
  if (!isSupabaseConfigured()) return null;
  const supabase = createClient();

  const [{ data }, { data: { user } }] = await Promise.all([
    supabase.from("custom_agents").select("*").order("created_at", { ascending: false }),
    supabase.auth.getUser(),
  ]);

  return (
    <AgentsView
      initialAgents={(data ?? []) as CustomAgent[]}
      userId={user?.id ?? ""}
    />
  );
}
