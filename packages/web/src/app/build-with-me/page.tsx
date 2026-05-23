"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useState } from "react";
import Image from "next/image";
import { CHROME_STORE_URL } from "@/config/urls";
import BuildWithMe from "@/components/BuildWithMe";

export default function BuildWithMePage() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="bg-[#020202] text-[#F5F5F5] font-sans overflow-x-hidden relative" style={{
      background: `
        radial-gradient(ellipse 80% 50% at 20% 20%, rgba(0,255,136,0.03) 0%, transparent 60%),
        radial-gradient(ellipse 60% 40% at 80% 80%, rgba(0,180,255,0.03) 0%, transparent 60%),
        #020202
      `
    }}>
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-[#1A1A1A] bg-[#0A0A0A]/92 backdrop-blur-md transition-all">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 h-14 flex items-center justify-between">
          {/* Logo */}
          <a href="/" className="flex items-center gap-2.5 shrink-0">
            <Image src="/logo.png" alt="ContextMover" width={56} height={56} priority style={{ height: 32, width: "auto" }} />
            <span className="font-bold text-[#F5F5F5] tracking-tight">ContextMover</span>
          </a>

          {/* Desktop center nav */}
          <div className="hidden md:flex items-center gap-0.5">
            <a href="/" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[#111]">Home</a>
            <a href="/pricing" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[#111]">Pricing</a>
            <a href="/docs" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors rounded-md hover:bg-[#111]">Docs</a>
            <a href="/build-with-me" className="px-3 py-1.5 text-sm text-[#00FF88]/70 hover:text-[#00FF88] transition-colors rounded-md hover:bg-[#111]">Build with me</a>
          </div>

          {/* Desktop right */}
          <div className="hidden md:flex items-center gap-2">
            <a href="/auth" className="px-3 py-1.5 text-sm text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors">Log in</a>
            <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer" className="bg-[#00FF88] text-[#0A0A0A] font-semibold text-sm px-4 py-1.5 rounded-md hover:bg-[#00CC6A] transition-colors shadow-[0_0_12px_rgba(0,255,136,0.2)]">Get for free</a>
          </div>

          {/* Mobile hamburger */}
          <button
            className="md:hidden flex items-center justify-center w-11 h-11 text-[#6B6B6B] hover:text-[#F5F5F5] active:opacity-80"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
          >
            <span className="text-2xl leading-none select-none">{menuOpen ? "✕" : "☰"}</span>
          </button>
        </div>

        {/* Mobile full-screen overlay menu */}
        {menuOpen && (
          <div className="md:hidden fixed inset-0 z-[200] bg-[#0A0A0A] flex flex-col" style={{ top: 0 }}>
            {/* Overlay header */}
            <div className="flex items-center justify-between px-5 h-14 border-b border-[#1A1A1A] shrink-0">
              <a href="/" className="flex items-center gap-2.5">
                <span className="font-bold text-[#F5F5F5] tracking-tight">ContextMover</span>
              </a>
              <button
                onClick={() => setMenuOpen(false)}
                className="flex items-center justify-center w-11 h-11 text-[#6B6B6B] hover:text-[#F5F5F5] active:opacity-80"
                aria-label="Close menu"
              >
                <span className="text-2xl leading-none">✕</span>
              </button>
            </div>
            {/* Overlay links */}
            <nav className="flex-1 overflow-y-auto px-5 py-4">
              {([
                ["Home", "/"],
                ["Pricing", "/pricing"],
                ["Docs", "/docs"],
                ["Build with me", "/build-with-me"],
              ] as const).map(([label, href]) => (
                <a key={label} href={href} className={`flex items-center text-[18px] min-h-[56px] px-3 border-b border-[#111] active:opacity-70 ${label === "Build with me" ? "text-[#00FF88]/70" : "text-[#6B6B6B]"}`} onClick={() => setMenuOpen(false)}>{label}</a>
              ))}
            </nav>
            {/* Overlay CTAs */}
            <div className="shrink-0 px-5 pb-8 pt-4 flex flex-col gap-3 border-t border-[#1A1A1A]">
              <a href="/auth" className="flex items-center justify-center border border-[#2A2A2A] text-[#F5F5F5] font-semibold text-base h-[52px] rounded-lg active:opacity-80" onClick={() => setMenuOpen(false)}>Log in</a>
              <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center bg-[#00FF88] text-[#0A0A0A] font-bold text-base h-[52px] rounded-lg active:scale-95 transition-transform shadow-[0_0_16px_rgba(0,255,136,0.25)]" onClick={() => setMenuOpen(false)}>Add to Chrome — free</a>
            </div>
          </div>
        )}
      </nav>

      {/* Main content with top padding for navbar */}
      <div className="pt-14">
        <BuildWithMe />
      </div>
    </div>
  );
}
