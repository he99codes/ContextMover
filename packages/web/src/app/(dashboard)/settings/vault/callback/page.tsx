"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

export default function VaultCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    // The OAuth code is extracted by the extension via chrome.tabs.onUpdated.
    // This page simply shows a holding message while the extension handles the flow.
    // If opened directly without the extension (e.g. bookmark), redirect to vault page.
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");

    if (error) {
      router.replace(`/settings/vault?error=${encodeURIComponent(error)}`);
      return;
    }

    if (!code) {
      router.replace("/settings/vault");
      return;
    }

    // Extension is listening via chrome.tabs.onUpdated and will complete the flow.
    // After ~5 seconds redirect to vault page so the user isn't stuck here.
    const timer = setTimeout(() => {
      router.replace("/settings/vault");
    }, 6_000);

    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A]">
      <div className="text-center">
        <Loader2 size={24} className="mx-auto mb-4 animate-spin text-[#00FF88]" />
        <p className="text-sm font-medium text-[#F5F5F5]">Connecting your vault…</p>
        <p className="mt-1 text-xs text-[#6B6B6B]">Return to the ContextMover extension to complete setup</p>
      </div>
    </div>
  );
}
