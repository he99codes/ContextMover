/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// scripts/bw-sweep.ts
//
// [CM-BW] Programmatic black-and-white color sweep. Replaces every green
// accent, status hue, and platform brand color with the canonical
// monochrome value from the megaplan color mapping. Runs across the
// extension sidebar, web app, and nested clone source trees.
//
// Usage:
//   node scripts/bw-sweep.ts <dir> [<dir> ...]
//
// Exit code 0 on success; prints per-file replacement counts.
// Idempotent — running twice is a no-op (all source values already replaced).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Canonical color mapping (from megaplan) ────────────────────────────────
// Order matters: longer/more-specific keys first so they win on overlap.
const MAP: Array<[string, string]> = [
  // Green accents → white
  ["#00FF88", "#FFFFFF"],
  ["#00ff88", "#FFFFFF"],
  ["#00CC6A", "#CCCCCC"],
  ["#00cc6a", "#CCCCCC"],
  ["#00D26A", "#CCCCCC"],
  ["#00d26a", "#CCCCCC"],
  // Status hues → grayscale
  ["#FF4444", "#FFFFFF"],
  ["#ff4444", "#FFFFFF"],
  ["#F59E0B", "#A0A0A0"],
  ["#f59e0b", "#A0A0A0"],
  // Green-tinted dark surfaces → neutral dark
  ["#0F1A0F", "#0A0A0A"],
  ["#0f1a0f", "#0A0A0A"],
  ["#0D1A0D", "#0A0A0A"],
  ["#0d1a0d", "#0A0A0A"],
  // Green-tinted borders → neutral borders
  ["#1A2A1A", "#2A2A2A"],
  ["#1a2a1a", "#2A2A2A"],
  ["#0D2A0D", "#2A2A2A"],
  ["#0d2a0d", "#2A2A2A"],
  // Dim green labels → muted gray
  ["#2A6A2A", "#6B6B6B"],
  ["#2a6a2a", "#6B6B6B"],
  // Platform brand hues → light gray
  ["#D97706", "#E5E5E5"],
  ["#d97706", "#E5E5E5"],
  ["#10B981", "#E5E5E5"],
  ["#6366F1", "#E5E5E5"],
  ["#6366f1", "#E5E5E5"],
  ["#20B2AA", "#E5E5E5"],
  ["#20b2aa", "#E5E5E5"],
  ["#4C8BF5", "#E5E5E5"],
  ["#4c8bf5", "#E5E5E5"],
  // [CM-BW] shadcn default primary blue → black (accent on light surfaces)
  ["#2563EB", "#0A0A0A"],
  ["#2563eb", "#0A0A0A"],
  // [CM-BW] red error hex → white (brightest = error per plan)
  ["#EF4444", "#FFFFFF"],
  ["#ef4444", "#FFFFFF"],
  // [CM-BW] dark red-tinted surface → neutral dark
  ["#2A1A1A", "#2A2A2A"],
  ["#2a1a1a", "#2A2A2A"],
  // [CM-BW] indigo-violet (Gemini gradient stop) → light gray
  ["#818CF8", "#E5E5E5"],
  ["#818cf8", "#E5E5E5"],
  // rgba greens → rgba white (preserve the trailing alpha by only matching
  // the rgb triplet prefix)
  ["rgba(0,255,136,", "rgba(255,255,255,"],
  ["rgba(0, 255, 136,", "rgba(255, 255, 255,"],
  ["rgba(0,255,120,", "rgba(255,255,255,"],
  ["rgba(0, 255, 120,", "rgba(255, 255, 255,"],
  ["rgba(0,210,106,", "rgba(255,255,255,"],
  ["rgba(0, 210, 106,", "rgba(255, 255, 255,"],
];

// Tailwind color utility class replacements (web app uses these heavily).
const CLASS_MAP: Array<[string, string]> = [
  // emerald-* → white/gray equivalents
  ["text-emerald-400", "text-white"],
  ["text-emerald-500", "text-white"],
  ["text-emerald-600", "text-gray-300"],
  ["text-emerald-700", "text-gray-300"],
  ["bg-emerald-400", "bg-white"],
  ["bg-emerald-500", "bg-white"],
  ["bg-emerald-600", "bg-gray-300"],
  ["bg-emerald-50", "bg-gray-100"],
  ["border-emerald-400", "border-white"],
  ["border-emerald-500", "border-white"],
  ["border-emerald-200", "border-gray-200"],
  ["from-emerald-400", "from-white"],
  ["from-emerald-500", "from-white"],
  ["to-emerald-400", "to-gray-400"],
  ["to-emerald-500", "to-gray-400"],
  // green-* → white/gray equivalents
  ["text-green-400", "text-white"],
  ["text-green-500", "text-white"],
  ["bg-green-400", "bg-white"],
  ["bg-green-500", "bg-white"],
  ["border-green-400", "border-white"],
  ["border-green-500", "border-white"],
  // [CM-BW] red-* (error/danger) → white (brightest = error per plan)
  ["text-red-400", "text-white"],
  ["text-red-500", "text-white"],
  ["bg-red-500/15", "bg-white/15"],
  ["bg-red-500/10", "bg-white/10"],
  ["bg-red-500/8", "bg-white/10"],
  ["bg-red-500/5", "bg-white/5"],
  ["bg-red-500", "bg-white"],
  ["bg-red-600/80", "bg-white/80"],
  ["bg-red-600", "bg-white"],
  ["border-red-500/50", "border-white/50"],
  ["border-red-500/40", "border-white/40"],
  ["border-red-500/30", "border-white/30"],
  ["border-red-500/25", "border-white/25"],
  ["border-red-500/20", "border-white/20"],
  ["hover:bg-red-500/10", "hover:bg-white/10"],
  ["hover:bg-red-500/5", "hover:bg-white/5"],
  ["hover:bg-red-950/50", "hover:bg-white/10"],
  ["hover:bg-red-600", "hover:bg-white"],
  ["hover:text-red-400", "hover:text-white"],
  ["hover:text-red-300", "hover:text-white"],
  ["hover:border-red-500/40", "hover:border-white/40"],
  ["hover:border-red-500/30", "hover:border-white/30"],
  ["focus:border-red-500/50", "focus:border-white/50"],
  // [CM-BW] blue-* (links/pricing) → white
  ["text-blue-400", "text-white"],
  ["text-blue-500", "text-white"],
  ["hover:bg-blue-950/50", "hover:bg-white/10"],
  // [CM-BW] yellow-/orange- (warnings/speed) → gray
  ["text-yellow-400", "text-gray-300"],
  ["text-yellow-200", "text-gray-300"],
  ["bg-yellow-500/5", "bg-white/5"],
  ["border-yellow-500/20", "border-white/20"],
  ["text-orange-400", "text-gray-400"],
  // [CM-BW] purple-* (checkmarks) → white
  ["text-purple-400", "text-white"],
  // [CM-BW] amber-/indigo-/teal- (platform badges, misc) → gray
  ["text-amber-700", "text-gray-300"],
  ["text-amber-400", "text-gray-400"],
  ["text-amber-300", "text-gray-400"],
  ["text-amber-300/90", "text-gray-400/90"],
  ["border-amber-500/40", "border-white/40"],
  ["bg-amber-50", "bg-gray-100"],
  ["border-amber-200", "border-gray-200"],
  ["text-indigo-700", "text-gray-300"],
  ["bg-indigo-50", "bg-gray-100"],
  ["border-indigo-200", "border-gray-200"],
  ["text-teal-700", "text-gray-300"],
  ["bg-teal-50", "bg-gray-100"],
  ["border-teal-200", "border-gray-200"],
  ["text-blue-700", "text-gray-300"],
  ["bg-blue-50", "bg-gray-100"],
  ["border-blue-200", "border-gray-200"],
  // [CM-BW] red shadow tint → white
  ["rgba(239,68,68,", "rgba(255,255,255,"],
];

const ALL_MAP = [...MAP, ...CLASS_MAP];

const EXTENSIONS = new Set([".ts", ".tsx", ".css", ".js", ".jsx", ".html"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // Skip node_modules, dist, .git, build artifacts
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".git" || e.name === ".next") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

function sweepFile(file: string): number {
  let content = fs.readFileSync(file, "utf-8");
  let count = 0;
  for (const [from, to] of ALL_MAP) {
    // Count non-overlapping occurrences for reporting.
    let idx = 0;
    while ((idx = content.indexOf(from, idx)) !== -1) {
      count++;
      idx += from.length;
    }
    if (count > 0 || content.includes(from)) {
      content = content.split(from).join(to);
    }
  }
  if (count > 0) fs.writeFileSync(file, content, "utf-8");
  return count;
}

function main() {
  const args = process.argv.slice(2);
  const dirs = args.length > 0 ? args : ["src/sidebar", "src/content/sidebar-toggle"];
  const roots = dirs.map(d => path.resolve(__dirname, "..", d));

  let total = 0;
  let filesChanged = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      console.warn(`[bw-sweep] skipping missing dir: ${root}`);
      continue;
    }
    const files = walk(root);
    for (const f of files) {
      const n = sweepFile(f);
      if (n > 0) {
        filesChanged++;
        total += n;
        console.log(`[bw-sweep] ${path.relative(process.cwd(), f)}: ${n} replacement(s)`);
      }
    }
  }
  console.log(`[bw-sweep] done — ${filesChanged} file(s) changed, ${total} total replacement(s).`);
}

main();
