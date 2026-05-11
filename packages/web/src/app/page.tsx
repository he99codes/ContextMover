import type { Metadata } from "next";
import LandingPage from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "ContextMover — Stop re-explaining yourself to every AI",
  description:
    "Capture, compress and migrate your AI conversations across Claude, ChatGPT, Gemini and Grok. Local-first. Privacy-first.",
  openGraph: {
    title: "ContextMover — Stop re-explaining yourself to every AI",
    description:
      "Capture, compress and migrate your AI conversations across Claude, ChatGPT, Gemini and Grok. Local-first. Privacy-first.",
    type: "website",
    siteName: "ContextMover",
  },
  twitter: {
    card: "summary_large_image",
    title: "ContextMover — Stop re-explaining yourself to every AI",
    description:
      "Capture, compress and migrate your AI conversations across Claude, ChatGPT, Gemini and Grok. Local-first. Privacy-first.",
  },
};

export default function Page() {
  return <LandingPage />;
}
