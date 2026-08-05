/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { VaultSetupWizard } from "@/components/dashboard/VaultSetupWizard";

export const metadata = { title: "Personal Vault — ContextMover" };

export default function VaultPage() {
  return (
    <div className="p-10">
      <div className="mb-10">
        <h1 className="text-2xl font-black uppercase text-[#00FF88]" style={{ letterSpacing: "0.14em", textShadow: "0 0 24px rgba(0,255,136,0.35)" }}>
          Personal Vault
        </h1>
        <p className="mt-1 text-xs font-mono uppercase text-[#6B6B6B]" style={{ letterSpacing: "0.12em" }}>
          Your data · Your Supabase · Zero ContextMover access
        </p>
      </div>
      <VaultSetupWizard />
    </div>
  );
}
