/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/attention/score/route.ts
//
// Signal-based importance scoring for a list of messages.
// Returns per-message scores (0–1) and ranked topIndices.
//
// Embedding-based cosine similarity is NOT performed here — embeddings
// live in the client's IndexedDB and are scored locally. This route
// applies pure-logic signal detection: decisions, errors, code, recency,
// goal relevance. The client overlays this on top of local cosine scores.
//
// Auth:  Supabase JWT Bearer token (same as all other extension routes)
// Limit: 60 req / hour per user

import { NextRequest, NextResponse } from "next/server";
import { getAuthUserFromRequest } from "@/lib/usage/helpers";
import { checkRateLimit } from "@/lib/rate-limiter";

export const runtime = "nodejs";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

interface ScoreRequest {
  messages: Message[];
  goal?: string;
}

interface ScoreResponse {
  scores: number[];
  topIndices: number[];
}

// ── Signal detection ─────────────────────────────────────────────────────────
// These patterns are the core IP — they define what the attention engine
// considers "important." They are not accessible in the extension bundle.

const DECISION_RE = [
  /\bwe decided\b/i, /\bdecided to\b/i, /\bgoing with\b/i, /\bopted for\b/i,
  /\bwe('?ll| will) use\b/i, /\bchose to\b/i, /\bswitching to\b/i,
  /\bmigrating to\b/i, /\bbest approach\b/i, /\bthe approach is\b/i,
  /\bwe use\b/i, /\bwent with\b/i, /\bshould use\b/i, /\bmust use\b/i,
  /\bthe solution\b/i, /\barchitecture\b/i, /\bthe plan\b/i,
];

const ERROR_RE = [
  /\b(?:Traceback|TypeError|ValueError|ReferenceError|SyntaxError|RuntimeError)\b/,
  /\bat\s+\w[\w.]*\s+\([^)]+:\d+:\d+\)/,
  /\bError:\s+\S/,
  /\bException\s+in\s+thread\b/,
  /\bthe issue was\b/i, /\broot cause\b/i, /\bbug was caused\b/i,
  /\bfixed by\b/i, /\bcaused by\b/i, /\bturned out (?:to be|that)\b/i,
  /\bregression\b/i, /\b(?:race condition|deadlock|memory leak)\b/i,
];

const GOAL_RE = [
  /\bthe goal\b/i, /\bour goal\b/i, /\bwe want to\b/i, /\bwe need to\b/i,
  /\bwe('?re| are) building\b/i, /\bnext step\b/i, /\bthe plan\b/i,
];

const CODE_FENCE_RE = /```[\s\S]*?```/;

// Weighted signal score components (sum must not exceed 1.0):
//   decision signal  → 0.25
//   error signal     → 0.30
//   goal signal      → 0.15
//   code presence    → 0.15
//   length bonus     → 0.07  (capped)
//   recency          → 0.08  (applied after per-message scoring)

function scoreMessageSignals(msg: Message): number {
  let score = 0;
  const t = msg.content;

  if (ERROR_RE.some((re) => re.test(t))) score += 0.30;
  if (DECISION_RE.some((re) => re.test(t))) score += 0.25;
  if (GOAL_RE.some((re) => re.test(t))) score += 0.15;
  if (CODE_FENCE_RE.test(t)) score += 0.15;
  score += Math.min(0.07, t.length / 8_000);

  return Math.min(0.92, score); // leave headroom for recency
}

function keywordOverlap(goal: string, content: string): number {
  if (!goal.trim()) return 0;
  const tokens = goal.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (tokens.length === 0) return 0;
  const lower = content.toLowerCase();
  const hits = tokens.filter((t) => lower.includes(t)).length;
  return 0.08 * (hits / tokens.length);
}

export async function POST(req: NextRequest) {
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await checkRateLimit(req, user.id, 60);
  if (!rl.ok) return rl.response;

  let body: ScoreRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { messages, goal = "" } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "messages must be a non-empty array" }, { status: 400 });
  }

  const total = messages.length;

  const scores = messages.map((msg, i) => {
    const signal = scoreMessageSignals(msg);
    const goalBoost = keywordOverlap(goal, msg.content);
    // Recency: linear decay — last message = +0.08, first = 0
    const recency = 0.08 * (i / Math.max(1, total - 1));
    return Math.min(1, signal + goalBoost + recency);
  });

  // topIndices: sorted descending by score, top 25% or at least 5
  const minTop = Math.max(5, Math.floor(total * 0.25));
  const topIndices = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .slice(0, minTop)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.i);

  const response: ScoreResponse = { scores, topIndices };
  return NextResponse.json(response);
}
