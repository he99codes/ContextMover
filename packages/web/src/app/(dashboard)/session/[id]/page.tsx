import { notFound } from "next/navigation";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
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

  const session = data as Session;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-[#1A1A1A]">
        {session.title ?? "Untitled session"}
      </h1>
      <p className="mt-1 text-sm text-[#6B6B6B]">
        {session.platform} · {session.messages.length} messages
      </p>
    </div>
  );
}
