import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "ContextForge",
    template: "%s · ContextForge",
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
      <body className="min-h-screen bg-[#F7F7F5] font-sans antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
