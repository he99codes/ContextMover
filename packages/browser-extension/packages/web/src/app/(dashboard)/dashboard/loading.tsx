/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

export default function DashboardLoading() {
  return (
    <div className="p-8 animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-32 rounded-[4px] bg-[#1A1A1A]" />
        <div className="mt-2 h-4 w-48 rounded-[4px] bg-[#1A1A1A]" />
      </div>
      <div className="mb-5 flex gap-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-7 w-16 rounded-[4px] bg-[#1A1A1A]" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-20 rounded-[8px] bg-[#111111] border border-[#1A1A1A]" />
        ))}
      </div>
    </div>
  );
}
