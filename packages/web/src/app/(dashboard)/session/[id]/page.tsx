import { VaultSessionDetail } from "@/components/dashboard/VaultSessionDetail";

export default function SessionPage({ params }: { params: { id: string } }) {
  return <VaultSessionDetail sessionId={params.id} />;
}
