import { VaultSessionList } from "@/components/dashboard/VaultSessionList";

export default function DashboardPage() {
  return (
    <div className="p-10">
      <div className="mb-10">
        <div className="flex items-end justify-between gap-6">
          <div>
            <h1 className="text-2xl font-black uppercase text-[#00FF88]" style={{ letterSpacing: "0.14em", textShadow: "0 0 24px rgba(0,255,136,0.35)" }}>
              Sessions
            </h1>
            <p className="mt-1 text-xs font-mono uppercase text-[#2A6A2A]" style={{ letterSpacing: "0.12em" }}>
              Captured conversations — stored in your personal vault
            </p>
          </div>
        </div>
      </div>

      <VaultSessionList />
    </div>
  );
}
