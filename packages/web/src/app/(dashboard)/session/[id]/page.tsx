import { notFound } from "next/navigation";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { SessionDetailView } from "@/components/dashboard/SessionDetailView";
import type { Session } from "@/types";

export default async function SessionPage({
  params,
}: {
  params: { id: string };
}) {
  if (!isSupabaseConfigured()) return null;

  const supabase = createClient();
  const { data } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", params.id)
    .single();

  if (!data) notFound();

  return <SessionDetailView session={data as Session} />;
}
