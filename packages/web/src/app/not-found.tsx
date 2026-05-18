/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0A0A0A] text-[#F5F5F5]">
      <div className="text-center">
        <p className="text-[80px] font-black leading-none text-[#00FF88]" style={{ textShadow: "0 0 40px rgba(0,255,136,0.3)" }}>
          404
        </p>
        <h1 className="mt-2 text-lg font-black uppercase tracking-widest text-[#F5F5F5]">Page not found</h1>
        <p className="mt-2 text-xs font-mono text-[#6B6B6B]">This route doesn&apos;t exist in ContextMover.</p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link href="/dashboard" className="rounded-[6px] border border-[#00FF88]/25 bg-[#00FF88]/8 px-5 py-2.5 text-xs font-black uppercase tracking-widest text-[#00FF88] hover:bg-[#00FF88]/12 transition-all">
            Dashboard
          </Link>
          <Link href="/" className="rounded-[6px] border border-[#2A2A2A] px-5 py-2.5 text-xs font-medium text-[#6B6B6B] hover:border-[#3A3A3A] hover:text-[#F5F5F5] transition-all">
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
