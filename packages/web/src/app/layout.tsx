/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import Script from "next/script";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { Analytics } from "@vercel/analytics/next";
// [SECURITY] Validate that no secret keys are accidentally exposed as NEXT_PUBLIC_.
import "@/lib/env-guard";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export const metadata: Metadata = {
  title: {
    default: "ContextMover",
    template: "%s · ContextMover",
  },
  description: "Never lose AI context again. Capture, manage, and migrate conversations across AI platforms.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} scroll-smooth`}>
      <body className="min-h-screen bg-[#0A0A0A] font-sans antialiased">
        {children}
        <footer className="border-t border-[#1A1A1A] py-5 px-6">
          <div className="flex flex-col sm:flex-row justify-center items-center gap-3 sm:gap-6" style={{ fontSize: "14px" }}>
            <Link href="/privacy" className="text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors flex items-center justify-center min-h-[44px] px-2">
              Privacy Policy
            </Link>
            <Link href="/terms" className="text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors flex items-center justify-center min-h-[44px] px-2">
              Terms
            </Link>
          </div>
        </footer>
        <Toaster />
        <Analytics />
        <Script
          src="https://checkout.razorpay.com/v1/checkout.js"
          strategy="lazyOnload"
        />
      </body>
    </html>
  );
}
