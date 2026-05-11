import type { Metadata } from "next";
import LandingPage from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "ContextForge — Stop re-explaining yourself to every AI",
  description:
    "Capture, compress and migrate your AI conversations across Claude, ChatGPT, Gemini and Grok. Local-first. Privacy-first.",
  openGraph: {
    title: "ContextForge — Stop re-explaining yourself to every AI",
    description:
      "Capture, compress and migrate your AI conversations across Claude, ChatGPT, Gemini and Grok. Local-first. Privacy-first.",
    type: "website",
    siteName: "ContextForge",
  },
  twitter: {
    card: "summary_large_image",
    title: "ContextForge — Stop re-explaining yourself to every AI",
    description:
      "Capture, compress and migrate your AI conversations across Claude, ChatGPT, Gemini and Grok. Local-first. Privacy-first.",
  },
};

export default function Page() {
  return <LandingPage />;
}
