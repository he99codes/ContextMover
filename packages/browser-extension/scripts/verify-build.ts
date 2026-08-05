/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/scripts/verify-build.ts
//
// Post-build verification gate. Runs after `vite build` and fails the build
// if any critical extension artifact is missing from dist/.
//
// This exists because v1.0.4 shipped without src/offscreen/offscreen.html
// (the vite.config.ts rollupOptions.input was missing the offscreen entry),
// which silently broke all ONNX embedding/indexing — "Page failed to load"
// at chrome.offscreen.createDocument() time.
//
// Run: `node scripts/verify-build.ts` (or via `pnpm build` which calls this).
// Exit code 1 on any missing file → CI/local build fails loudly.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ESM-safe replacement for __dirname (package.json has "type": "module").
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distRoot = path.resolve(__dirname, "..", "dist");
const errors: string[] = [];
const warnings: string[] = [];

function checkExists(relPath: string, label: string): boolean {
  const abs = path.resolve(distRoot, relPath);
  if (!fs.existsSync(abs)) {
    errors.push(`MISSING: ${relPath} (${label})`);
    return false;
  }
  return true;
}

function checkGlob(relDir: string, pattern: RegExp, label: string): boolean {
  const absDir = path.resolve(distRoot, relDir);
  if (!fs.existsSync(absDir)) {
    errors.push(`MISSING DIR: ${relDir} (${label})`);
    return false;
  }
  const files = fs.readdirSync(absDir);
  const matches = files.filter((f) => pattern.test(f));
  if (matches.length === 0) {
    errors.push(`MISSING: no file matching ${pattern} in ${relDir}/ (${label})`);
    return false;
  }
  return true;
}

function checkManifestOffscreen(): boolean {
  const manifestPath = path.resolve(distRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push("MISSING: manifest.json");
    return false;
  }
  try {
    const mf = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const hasOffscreen = Array.isArray(mf.permissions) && mf.permissions.includes("offscreen");
    if (!hasOffscreen) {
      errors.push('manifest.json missing "offscreen" permission — offscreen doc cannot be created');
      return false;
    }
    return true;
  } catch (e) {
    errors.push(`manifest.json parse error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

console.log("[verify-build] checking dist/ for critical artifacts...");

// ── Critical: offscreen document (the v1.0.4 regression) ──────────────────
checkExists("src/offscreen/offscreen.html", "offscreen HTML doc — required for ONNX embedding");
checkGlob("assets", /^offscreen-.*\.js$/, "offscreen JS bundle — required for ONNX embedding");

// ── Sidebar (main UI surface) ──────────────────────────────────────────────
checkExists("src/sidebar/index.html", "sidebar HTML — main UI surface");

// ── WASM runtimes ──────────────────────────────────────────────────────────
checkExists("tree-sitter.wasm", "tree-sitter WASM — required for code parsing");
checkGlob("assets", /^ort-wasm-simd\.wasm$/, "transformers ONNX WASM — required for MiniLM embedding");

// ── Manifest ───────────────────────────────────────────────────────────────
checkManifestOffscreen();

// ── Service worker loader ──────────────────────────────────────────────────
checkExists("service-worker-loader.js", "service worker loader — MV3 background entry");
checkGlob("assets", /^service-worker.*\.js$/, "service worker bundle");

// ── Report ─────────────────────────────────────────────────────────────────
if (warnings.length > 0) {
  console.warn("[verify-build] warnings:");
  for (const w of warnings) console.warn(`  ⚠️  ${w}`);
}

if (errors.length > 0) {
  console.error("[verify-build] FAILED — critical artifacts missing from dist/:");
  for (const e of errors) console.error(`  ❌ ${e}`);
  console.error("");
  console.error("[verify-build] The build is incomplete and will not function correctly.");
  console.error("[verify-build] Most common cause: vite.config.ts rollupOptions.input is missing");
  console.error("[verify-build] the offscreen/sidebar HTML entries. See git history for the fix.");
  process.exit(1);
}

console.log("[verify-build] OK — all critical artifacts present in dist/.");
process.exit(0);
