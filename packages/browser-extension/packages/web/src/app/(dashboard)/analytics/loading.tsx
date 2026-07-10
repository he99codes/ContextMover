/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

export default function AnalyticsLoading() {
  return (
    <div className="p-8 animate-pulse">
      <div className="mb-6 h-7 w-28 rounded-[4px] bg-[#1A1A1A]" />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 rounded-[8px] bg-[#111111] border border-[#1A1A1A]" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 rounded-[8px] bg-[#111111] border border-[#1A1A1A]" />
        ))}
      </div>
    </div>
  );
}
