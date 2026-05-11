import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import Script from "next/script";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
// [SECURITY] Validate that no secret keys are accidentally exposed as NEXT_PUBLIC_.
import "@/lib/env-guard";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

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
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-[#0A0A0A] font-sans antialiased">
        {children}
        <footer className="border-t border-[#1A1A1A] py-5 px-6">
          <div className="flex justify-center gap-6" style={{ fontSize: "13px" }}>
            <Link href="/privacy" className="text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors">
              Privacy Policy
            </Link>
            <Link href="/terms" className="text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors">
              Terms
            </Link>
          </div>
        </footer>
        <Toaster />
        <Script
          src="https://checkout.razorpay.com/v1/checkout.js"
          strategy="lazyOnload"
        />
      </body>
    </html>
  );
}
