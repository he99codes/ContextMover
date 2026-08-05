/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// src/sidebar/MigrationStepper.tsx
//
// [CM-SOLAR-V2] Animated 6-step migration stepper.
// Maps the 13 service-worker `MIGRATION_PROGRESS` stage strings to 6
// canonical animated steps: Capture → Build → Summarize → Retrieve →
// Format → Inject. Each step has 3 states: pending (dim gray dot),
// active (orange dot with ember-pulse + label with solar-text-glow),
// done (gold ✓). Steps irrelevant to the current tier are skipped.
//
// Two variants:
//   - "full"    → labeled horizontal row (used in MigrationModal)
//   - "compact" → 6 small dots only (used inline on SessionCard)

import React from "react";

export type StepKey = "capture" | "build" | "summarize" | "retrieve" | "format" | "inject";

interface StepDef {
  key: StepKey;
  label: string;
  /** Progress threshold at which this step is considered "done". */
  doneAt: number;
  /** Stage strings (from service-worker `reportProgress`) that mark this step active. */
  stageMatches: string[];
}

const STEPS: StepDef[] = [
  { key: "capture",   label: "Capture",   doneAt: 15,  stageMatches: ["Loading session..."] },
  { key: "build",     label: "Build",     doneAt: 25,  stageMatches: ["Building context file..."] },
  { key: "summarize", label: "Summarize", doneAt: 70,  stageMatches: [
    "Extracting smart summary...",
    "Running attention engine...",
    "Warming up model...",
  ] },
  { key: "retrieve",  label: "Retrieve",  doneAt: 78,  stageMatches: [
    "Indexing session...",
    "Retrieving relevant chunks...",
    "Using keyword ranking (semantic warming up)...",
  ] },
  { key: "format",    label: "Format",    doneAt: 85,  stageMatches: ["Building instructions..."] },
  { key: "inject",    label: "Inject",    doneAt: 95,  stageMatches: ["Injecting instructions..."] },
];

/** Steps relevant to each tier. Tier 1 skips summarize+retrieve; Tier 2 skips retrieve. */
const TIER_STEPS: Record<1 | 2 | 3, StepKey[]> = {
  1: ["capture", "build", "format", "inject"],
  2: ["capture", "build", "summarize", "format", "inject"],
  3: ["capture", "build", "summarize", "retrieve", "format", "inject"],
};

type StepState = "pending" | "active" | "done";

function resolveStepState(
  step: StepDef,
  stage: string,
  progress: number,
  isLast: boolean
): StepState {
  // "Done" stage → everything is done.
  if (stage === "Done" || progress >= 100) return "done";
  // Active if the current stage string matches this step.
  if (step.stageMatches.some((s) => stage.startsWith(s))) return "active";
  // Done if progress passed this step's threshold.
  if (progress >= step.doneAt) return "done";
  // If this is the last step and progress is past 90, mark active.
  if (isLast && progress >= 85) return "active";
  return "pending";
}

export interface MigrationStepperProps {
  stage: string;
  progress: number;
  tier: 1 | 2 | 3;
  variant?: "full" | "compact";
}

export const MigrationStepper: React.FC<MigrationStepperProps> = React.memo(function MigrationStepper({
  stage,
  progress,
  tier,
  variant = "full",
}) {
  const activeKeys = TIER_STEPS[tier];
  const activeSteps = STEPS.filter((s) => activeKeys.includes(s.key));

  // ── Compact variant: 6 small dots in a row ──────────────────────────────
  if (variant === "compact") {
    return (
      <div className="flex items-center gap-1">
        {activeSteps.map((step, i) => {
          const state = resolveStepState(step, stage, progress, i === activeSteps.length - 1);
          return (
            <span
              key={step.key}
              className={`mini-step-dot ${state}`}
              title={`${step.label}: ${state}`}
            />
          );
        })}
      </div>
    );
  }

  // ── Full variant: labeled horizontal row with connecting line ───────────
  return (
    <div className="relative my-2">
      {/* Connecting line */}
      <div className="absolute top-[5px] left-2 right-2 h-px bg-[#2A2A2A]" />
      <div
        className="absolute top-[5px] left-2 h-px transition-all duration-300"
        style={{
          width: `calc((100% - 16px) * ${Math.min(progress, 100) / 100})`,
          background: "linear-gradient(90deg, #00FF88, #00C853)",
          boxShadow: "0 0 6px rgba(0,255,136,0.5)",
        }}
      />
      <div className="relative flex items-start justify-between">
        {activeSteps.map((step, i) => {
          const state = resolveStepState(step, stage, progress, i === activeSteps.length - 1);
          const color =
            state === "done" ? "#00C853" : state === "active" ? "#00FF88" : "#2A2A2A";
          return (
            <div key={step.key} className="flex flex-1 flex-col items-center gap-1">
              <span
                className={`inline-block rounded-full ${state === "active" ? "animate-ember-pulse" : ""}`}
                style={{
                  width: 10,
                  height: 10,
                  background: color,
                  boxShadow:
                    state === "active"
                      ? "0 0 8px rgba(0,255,136,0.6)"
                      : state === "done"
                      ? "0 0 6px rgba(0,210,106,0.5)"
                      : "none",
                  border: "2px solid #050505",
                  transition: "background 200ms ease, box-shadow 200ms ease",
                }}
              />
              <span
                className={`text-[8px] font-bold uppercase tracking-wider ${state === "active" ? "animate-solar-text" : ""}`}
                style={{
                  color: state === "pending" ? "#6B6B6B" : color,
                  letterSpacing: "0.06em",
                }}
              >
                {state === "done" ? "✓ " : ""}{step.label}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 text-center text-[9px] font-mono uppercase tracking-wider text-[#6B6B6B]">
        {stage || "Processing..."} · {Math.round(progress)}%
      </div>
    </div>
  );
});
