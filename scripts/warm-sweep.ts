/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// scripts/warm-sweep.ts
//
// [CM-SOLAR] Converts the B&W output from the previous sweep into the
// Solar Flare palette: orange/gold/minimal pink/silver.
// This pass is intentionally broad: the hex values it targets were all
// introduced by the B&W sweep from green/status/platform/blue colors.
//
// Usage:
//   node --experimental-strip-types scripts/warm-sweep.ts [dirs...]

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HEX_REPLACEMENTS: Array<[RegExp, string]> = [
  // Any remaining #FFFFFF (came from green/red accent) → orange
  [/#FFFFFF/g, "#FF8A00"],
  [/#ffffff/g, "#FF8A00"],
  // Any remaining #E5E5E5 (came from platform colors) → silver
  [/#E5E5E5/g, "#C0C0C0"],
  [/#e5e5e5/g, "#C0C0C0"],
  // Any remaining #CCCCCC (came from green-dim) → gold
  [/#CCCCCC/g, "#FFB800"],
  [/#cccccc/g, "#FFB800"],
  // Any remaining #A0A0A0 in color context (came from warning amber) → gold
  [/#A0A0A0/g, "#FFB800"],
  [/#a0a0a0/g, "#FFB800"],
  // Dark green-tinted surfaces (leftover from original green UI) → neutral dark
  [/#0F1A0F/g, "#0A0A0A"],
  [/#0D1A0D/g, "#0A0A0A"],
  [/#1A2A1A/g, "#1A1A1A"],
  [/#1A3A1A/g, "#1A1A1A"],
  [/#2A3A2A/g, "#2A2A2A"],
  [/#2A4A2A/g, "#2A2A2A"],
  // Dark blue-tinted surfaces (leftover from shadcn blue) → neutral dark
  [/#1A1A3A/g, "#1A1A1A"],
  [/#2A2A4A/g, "#2A2A2A"],
  // Blue accents (leftover shadcn / links) → orange
  [/#5AA9FF/g, "#FF8A00"],
  [/#5aa9ff/g, "#FF8A00"],
  [/#7A9ABB/g, "#FFB800"],
  [/#7a9abb/g, "#FFB800"],
  [/#2563EB/g, "#FF8A00"],
  [/#2563eb/g, "#FF8A00"],
  [/#4C8BF5/g, "#FF8A00"],
  [/#4c8bf5/g, "#FF8A00"],
  // Red error → warm coral
  [/#FF4444/g, "#FF6B6B"],
  [/#ff4444/g, "#FF6B6B"],
  [/#EF4444/g, "#FF6B6B"],
  [/#ef4444/g, "#FF6B6B"],
  // White rgba glows → orange glows
  [/rgba\(255,\s*255,\s*255,/g, "rgba(255,138,0,"],
  // Blue rgba tints → orange glows
  [/rgba\(90,\s*169,\s*255,/g, "rgba(255,138,0,"],
  // Indigo/violet (Gemini gradient stop) → silver
  [/#818CF8/g, "#C0C0C0"],
  [/#818cf8/g, "#C0C0C0"],
  // Platform brand hues → warm gray
  [/#D97706/g, "#FF8A00"],
  [/#d97706/g, "#FF8A00"],
  [/#10B981/g, "#FF8A00"],
  [/#10b981/g, "#FF8A00"],
  [/#6366F1/g, "#C0C0C0"],
  [/#6366f1/g, "#C0C0C0"],
  [/#20B2AA/g, "#C0C0C0"],
  [/#20b2aa/g, "#C0C0C0"],
  // Tailwind emerald/green colors that might still exist
  [/#6EE7B7/g, "#FFB800"],
  [/#6ee7b7/g, "#FFB800"],
  [/#34D399/g, "#FF8A00"],
  [/#34d399/g, "#FF8A00"],
  [/#A7F3D0/g, "#FFB800"],
  [/#a7f3d0/g, "#FFB800"],
  [/#10B981/g, "#FF8A00"],
  [/#10b981/g, "#FF8A00"],
];

const CLASS_REPLACEMENTS: Array<[RegExp, string]> = [
  // shadcn switch checked state: blue/black → orange
  [/data-\[state=checked\]:bg-\[#0A0A0A\]/g, "data-[state=checked]:bg-[#FF8A00]"],
  // shadcn badge default: blue → orange
  [/bg-\[#0A0A0A\] text-white/g, "bg-[#FF8A00] text-white"],
  // shadcn tab active: white bg/dark text → orange bg/white text
  [/data-\[state=active\]:bg-white data-\[state=active\]:text-\[#1A1A1A\]/g, "data-[state=active]:bg-[#FF8A00] data-[state=active]:text-white"],
  // Any leftover black focus rings on light surfaces → orange
  [/focus-visible:ring-\[#0A0A0A\]/g, "focus-visible:ring-[#FF8A00]"],
  [/focus-visible:border-\[#0A0A0A\]/g, "focus-visible:border-[#FF8A00]"],
  [/focus:ring-\[#0A0A0A\]/g, "focus:ring-[#FF8A00]"],
  [/focus:border-\[#0A0A0A\]/g, "focus:border-[#FF8A00]"],
  [/text-\[#0A0A0A\]/g, "text-[#FF8A00]"],
  // Convert green-origin ghost buttons / boxes that became white in B&W.
  // These are accent contexts; normal text-white on dark is not affected.
  [/border-white\/20\s+bg-white\/5([^"`]*)text-white/g, "border-[#FF8A00]/20 bg-[#FF8A00]/5$1text-[#FF8A00]"],
  [/border-white\/25\s+bg-white\/6\s+text-white/g, "border-[#FF8A00]/25 bg-[#FF8A00]/6 text-[#FF8A00]"],
  [/border-white\/30\s+bg-white\/5([^"`]*)text-white/g, "border-[#FF8A00]/30 bg-[#FF8A00]/5$1text-[#FF8A00]"],
  [/border-white\/30\s+bg-white\/10([^"`]*)text-white/g, "border-[#FF8A00]/30 bg-[#FF8A00]/10$1text-[#FF8A00]"],
  [/border-white\/40\s+bg-white\/10([^"`]*)text-white/g, "border-[#FF8A00]/40 bg-[#FF8A00]/10$1text-[#FF8A00]"],
  [/bg-white\/20\s+text-white([^"`]*)border-white\/30/g, "bg-[#FF8A00]/20 text-[#FF8A00]$1border-[#FF8A00]/30"],
  // Hover states
  [/hover:border-white\/40\s+hover:bg-white\/10\s+hover:text-\[#FF8A00\]/g, "hover:border-[#FF8A00]/40 hover:bg-[#FF8A00]/10 hover:text-[#FFB800]"],
  [/hover:border-white\/40\s+hover:bg-white\/10\s+hover:text-white/g, "hover:border-[#FF8A00]/40 hover:bg-[#FF8A00]/10 hover:text-[#FF8A00]"],
  [/hover:border-white\/30\s+hover:bg-white\/10\s+hover:text-white/g, "hover:border-[#FF8A00]/30 hover:bg-[#FF8A00]/10 hover:text-[#FF8A00]"],
  [/hover:bg-white\/10\s+hover:text-white/g, "hover:bg-[#FF8A00]/10 hover:text-[#FF8A00]"],
  // Generic hover:text-white near muted gray text → orange
  [/text-\[#6B6B6B\]\s+transition[^"`]*hover:text-white/g, "text-[#6B6B6B] transition hover:text-[#FF8A00]"],
  // Danger / delete hover states → coral
  [/hover:text-white\s+hover:border-white/g, "hover:text-[#FF6B6B] hover:border-[#FF6B6B]"],
];

const ALL = [...HEX_REPLACEMENTS, ...CLASS_REPLACEMENTS];

const EXTENSIONS = new Set([".ts", ".tsx", ".css", ".js", ".jsx", ".html"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
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
  for (const [regex] of ALL) {
    const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
    let match;
    while ((match = re.exec(content)) !== null) count++;
  }
  for (const [regex, to] of ALL) {
    content = content.replace(regex, to);
  }
  if (count > 0) fs.writeFileSync(file, content, "utf-8");
  return count;
}

function main() {
  const args = process.argv.slice(2);
  const dirs = args.length > 0 ? args : ["src", "packages/web/src", "packages/browser-extension/src"];
  const roots = dirs.map(d => path.resolve(__dirname, "..", d));

  let total = 0, filesChanged = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) { console.warn(`[warm-sweep] skipping missing dir: ${root}`); continue; }
    for (const f of walk(root)) {
      const n = sweepFile(f);
      if (n > 0) {
        filesChanged++; total += n;
        console.log(`[warm-sweep] ${path.relative(process.cwd(), f)}: ${n} replacement(s)`);
      }
    }
  }
  console.log(`[warm-sweep] done — ${filesChanged} file(s) changed, ${total} total replacement(s).`);
}

main();
