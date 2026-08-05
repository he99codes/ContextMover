/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// scripts/green-sweep.ts
//
// [CM-GREEN-REVERT] Reverts the Solar Flare (orange/gold/pink/silver)
// palette back to the original green & black theme.
//
// Usage:
//   node --experimental-strip-types scripts/green-sweep.ts [dirs...]

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HEX_REPLACEMENTS: Array<[RegExp, string]> = [
  // Primary orange → primary green
  [/#FF8A00/g, "#00FF88"],
  [/#ff8a00/g, "#00FF88"],
  // Gold → green-dim
  [/#FFB800/g, "#00D26A"],
  [/#ffb800/g, "#00D26A"],
  // Bright gold → green-dim2
  [/#FFD700/g, "#00C853"],
  [/#ffd700/g, "#00C853"],
  // Pink (NEW/BETA badges) → purple (original)
  [/#FF4F8A/g, "#A855F7"],
  [/#ff4f8a/g, "#A855F7"],
  // Silver → light gray (original)
  [/#C0C0C0/g, "#E5E5E5"],
  [/#c0c0c0/g, "#E5E5E5"],
  // Coral error → red (original)
  [/#FF6B6B/g, "#FF4444"],
  [/#ff6b6b/g, "#FF4444"],
  // Orange rgba glows → green glows
  [/rgba\(255,\s*138,\s*0,/g, "rgba(0,255,136,"],
  [/rgba\(255,\s*215,\s*0,/g, "rgba(0,210,106,"],
  // Orange hsl/tailwind class tints
  [/rgba\(255,\s*184,\s*0,/g, "rgba(0,210,106,"],
];

const CLASS_REPLACEMENTS: Array<[RegExp, string]> = [
  // Tailwind orange opacity classes → green
  [/border-\[#FF8A00\]/g, "border-[#00FF88]"],
  [/bg-\[#FF8A00\]/g, "bg-[#00FF88]"],
  [/text-\[#FF8A00\]/g, "text-[#00FF88]"],
  [/border-\[#FF8A00\]\/(\d+)/g, "border-[#00FF88]/$1"],
  [/bg-\[#FF8A00\]\/(\d+)/g, "bg-[#00FF88]/$1"],
  [/text-\[#FF8A00\]\/(\d+)/g, "text-[#00FF88]/$1"],
  // Gold classes → green-dim
  [/border-\[#FFB800\]/g, "border-[#00D26A]"],
  [/bg-\[#FFB800\]/g, "bg-[#00D26A]"],
  [/text-\[#FFB800\]/g, "text-[#00D26A]"],
  [/border-\[#FFB800\]\/(\d+)/g, "border-[#00D26A]/$1"],
  [/bg-\[#FFB800\]\/(\d+)/g, "bg-[#00D26A]/$1"],
  [/text-\[#FFB800\]\/(\d+)/g, "text-[#00D26A]/$1"],
  // Pink classes → purple
  [/border-\[#FF4F8A\]/g, "border-[#A855F7]"],
  [/bg-\[#FF4F8A\]/g, "bg-[#A855F7]"],
  [/text-\[#FF4F8A\]/g, "text-[#A855F7]"],
  [/border-\[#FF4F8A\]\/(\d+)/g, "border-[#A855F7]/$1"],
  [/bg-\[#FF4F8A\]\/(\d+)/g, "bg-[#A855F7]/$1"],
  [/text-\[#FF4F8A\]\/(\d+)/g, "text-[#A855F7]/$1"],
  // Coral classes → red
  [/border-\[#FF6B6B\]/g, "border-[#FF4444]"],
  [/bg-\[#FF6B6B\]/g, "bg-[#FF4444]"],
  [/text-\[#FF6B6B\]/g, "text-[#FF4444]"],
  [/border-\[#FF6B6B\]\/(\d+)/g, "border-[#FF4444]/$1"],
  [/bg-\[#FF6B6B\]\/(\d+)/g, "bg-[#FF4444]/$1"],
  [/text-\[#FF6B6B\]\/(\d+)/g, "text-[#FF4444]/$1"],
  // Silver classes → light gray
  [/border-\[#C0C0C0\]/g, "border-[#E5E5E5]"],
  [/bg-\[#C0C0C0\]/g, "bg-[#E5E5E5]"],
  [/text-\[#C0C0C0\]/g, "text-[#E5E5E5]"],
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
    if (!fs.existsSync(root)) { console.warn(`[green-sweep] skipping missing dir: ${root}`); continue; }
    for (const f of walk(root)) {
      const n = sweepFile(f);
      if (n > 0) {
        filesChanged++; total += n;
        console.log(`[green-sweep] ${path.relative(process.cwd(), f)}: ${n} replacement(s)`);
      }
    }
  }
  console.log(`[green-sweep] done — ${filesChanged} file(s) changed, ${total} total replacement(s).`);
}

main();
