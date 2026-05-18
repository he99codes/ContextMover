"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { Bot } from "lucide-react";
import type { CustomAgent } from "@/types";

interface Props {
  initialAgents: CustomAgent[];
  userId: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function AgentsView(_props: Props) {
  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[#F5F5F5]">Agents</h1>
        <p className="mt-1 text-sm text-[#6B6B6B]">
          Configure custom AI platforms beyond the built-in Claude / ChatGPT / Gemini / Grok.
        </p>
      </div>

      <div className="flex flex-col items-center rounded-[8px] border border-dashed border-[#2A2A2A] bg-[#111111] py-24 text-center">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-[8px] bg-[#00FF88]/8 border border-[#00FF88]/15">
          <Bot size={22} className="text-[#00FF88]/60" />
        </div>
        <div className="mb-4 text-[9px] font-mono uppercase tracking-[0.2em] border border-[#2A2A2A] text-[#3A3A3A] px-2.5 py-1 rounded-[4px]">
          Coming soon
        </div>
        <h3 className="text-sm font-semibold text-[#F5F5F5]">AI Agents</h3>
        <p className="mt-2 max-w-sm text-sm text-[#6B6B6B] leading-relaxed">
          Extend ContextMover to any AI platform. Custom capture rules, migration targets,
          and agent configurations — all in one place.
        </p>
      </div>
    </div>
  );
}
