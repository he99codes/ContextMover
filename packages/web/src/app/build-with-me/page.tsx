"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import BuildWithMe from "@/components/BuildWithMe";

export default function BuildWithMePage() {
  return (
    <div className="bg-[#020202] text-[#F5F5F5] font-sans overflow-x-hidden relative" style={{
      background: `
        radial-gradient(ellipse 80% 50% at 20% 20%, rgba(0,255,136,0.03) 0%, transparent 60%),
        radial-gradient(ellipse 60% 40% at 80% 80%, rgba(0,180,255,0.03) 0%, transparent 60%),
        #020202
      `
    }}>
      <BuildWithMe />
    </div>
  );
}
