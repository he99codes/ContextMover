import type { Metadata } from "next";
import LandingPage from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "ContextMover — Stop re-explaining yourself to every AI",
  description:
    "Capture, compress and migrate your AI conversations across Claude, ChatGPT, Gemini and Grok. Local-first. Privacy-first.",
  keywords: [
    "AI context migration",
    "Claude ChatGPT Gemini Grok",
    "conversation capture",
    "privacy first AI tool",
    "freelance developer India",
    "hire developer side project",
    "build MVP developer Pune",
  ],
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

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "Build with Priyanshu",
  description: "Side project and startup development",
  provider: {
    "@type": "Person",
    name: "Priyanshu Sharma",
    url: "https://contextmover.com",
  },
  areaServed: "Worldwide",
  priceRange: "Contact for pricing",
};

export default function Page() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      <LandingPage />
    </>
  );
}
