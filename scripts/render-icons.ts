/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// scripts/render-icons.ts
//
// [CM-BW] Rasterizes public/icon.svg into the PNG icons required by
// manifest.json (16/32/48/128) and the web/extension logo (256).
// Run after editing icon.svg:  pnpm exec tsx scripts/render-icons.ts

import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const svgPath = path.join(root, "public", "icon.svg");
const iconsDir = path.join(root, "public", "icons");
const logoPath = path.join(root, "public", "logo.png");
const webLogoPath = path.join(root, "packages", "web", "public", "logo.png");

async function main() {
  if (!fs.existsSync(svgPath)) {
    console.error(`[render-icons] SVG not found: ${svgPath}`);
    process.exit(1);
  }
  fs.mkdirSync(iconsDir, { recursive: true });

  const svg = fs.readFileSync(svgPath);
  const sizes = [16, 32, 48, 128];

  for (const s of sizes) {
    const out = path.join(iconsDir, `icon${s}.png`);
    await sharp(svg).resize(s, s).png().toFile(out);
    console.log(`[render-icons] wrote ${path.relative(root, out)}`);
  }

  await sharp(svg).resize(256, 256).png().toFile(logoPath);
  console.log(`[render-icons] wrote ${path.relative(root, logoPath)}`);

  // Mirror to web app public/
  fs.copyFileSync(logoPath, webLogoPath);
  console.log(`[render-icons] copied → ${path.relative(root, webLogoPath)}`);

  console.log("[render-icons] done.");
}

main().catch((err) => {
  console.error("[render-icons] failed:", err);
  process.exit(1);
});
