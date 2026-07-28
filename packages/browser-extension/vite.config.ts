/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";
import path from "path";
import fs from "fs";

// Remove crx-plugin duplicate of public/ assets.
function cleanupPublicDupPlugin(): Plugin {
  return {
    name: "cleanup-public-dup",
    apply: "build",
    closeBundle() {
      const publicDup = path.resolve(__dirname, "dist/public");
      if (fs.existsSync(publicDup)) {
        fs.rmSync(publicDup, { recursive: true, force: true });
        console.log("[vite:cleanup-public-dup] removed duplicate dist/public/");
      }
    },
  };
}

// Copy web-tree-sitter WASM runtime file to dist/ root.
// The main runtime file must be at the dist root to match chrome.runtime.getURL('tree-sitter.wasm').
function copyTreeSitterWasmPlugin(): Plugin {
  return {
    name: "copy-tree-sitter-wasm",
    closeBundle() {
      // 0.26.x ships web-tree-sitter.wasm; 0.20.x ships tree-sitter.wasm — try both.
      const srcNew = path.resolve(__dirname, "node_modules/web-tree-sitter/web-tree-sitter.wasm");
      const srcOld = path.resolve(__dirname, "node_modules/web-tree-sitter/tree-sitter.wasm");
      const src = fs.existsSync(srcNew) ? srcNew : srcOld;
      const dest = path.resolve(__dirname, "dist");

      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dest, "tree-sitter.wasm"));
        console.log(`[copy-tree-sitter-wasm] copied tree-sitter.wasm to dist/`);
      } else {
        console.warn(`[copy-tree-sitter-wasm] source file not found: ${src}`);
      }
    },
  };
}

// [OAUTH-FIX] @crxjs/vite-plugin strips the "key" field from manifest.json.
// This plugin re-injects it after build so the extension ID matches the
// OAuth redirect URI configured in Google Cloud Console.
function injectKeyPlugin(): Plugin {
  return {
    name: "inject-manifest-key",
    apply: "build",
    closeBundle() {
      const distManifest = path.resolve(__dirname, "dist/manifest.json");
      if (!fs.existsSync(distManifest)) return;
      const mf = JSON.parse(fs.readFileSync(distManifest, "utf-8"));
      if (!mf.key && (manifest as any).key) {
        mf.key = (manifest as any).key;
        fs.writeFileSync(distManifest, JSON.stringify(mf, null, 2));
        console.log("[inject-manifest-key] re-injected key into dist/manifest.json");
      }
    },
  };
}

function copyTransformersWasmPlugin(): Plugin {
  return {
    name: "copy-transformers-wasm",
    closeBundle() {
      const src = path.resolve(
        __dirname,
        "node_modules/@xenova/transformers/dist"
      );
      const dest = path.resolve(__dirname, "dist/assets");

      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

      // Only copy the SIMD variant — Chrome 89+ always supports SIMD,
      // and shipping all 4 variants wastes ~28 MB. Single-threaded SIMD
      // is sufficient for MiniLM inference.
      const files = fs.readdirSync(src)
        .filter((f) => f === "ort-wasm-simd.wasm");
      for (const file of files) {
        fs.copyFileSync(path.join(src, file), path.join(dest, file));
        console.log(`[copy-transformers-wasm] copied ${file}`);
      }
    },
  };
}

// ── Production-only: strip console.log/warn/debug that lack [CM:]/[ContextMover] tags.
// Works at renderChunk level so it catches tree-shaken compiled output.
// Multi-line calls and template-literal calls are left as-is (safe default).
function stripNonCmLogs(): Plugin {
  return {
    name: "strip-non-cm-logs",
    enforce: "post",
    renderChunk(code, chunk) {
      // Skip shared / vendor chunks (facadeModuleId is null for those).
      // Also skip offscreen chunks — they contain the bundled transformers
      // minified library which this regex can accidentally corrupt.
      if (!chunk.facadeModuleId || chunk.facadeModuleId.includes("offscreen")) return null;
      const result = code.replace(
        /console\.(log|warn|debug)\(\s*(["'`][^"'`\n]*["'`])[^)]*\);?/g,
        (match) => (/\[(?:CM:|ContextMover)/.test(match) ? match : "")
      );
      return result === code ? null : { code: result, map: null };
    },
  };
}

// ── Production-only: javascript-obfuscator via rollup-plugin-obfuscator.
// Excluded chunks: embedding worker (WASM-heavy, perf-critical), vendor
// bundles, and offscreen doc (stability boundary with WASM modules).
async function obfuscatorPlugin(): Promise<Plugin> {
  const { default: obfuscatorRollup } = await import("rollup-plugin-obfuscator");
  return obfuscatorRollup({
    options: {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.75,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.4,
      debugProtection: false,
      disableConsoleOutput: false,
      identifierNamesGenerator: "hexadecimal",
      renameGlobals: false,
      rotateStringArray: true,
      selfDefending: false,
      shuffleStringArray: true,
      splitStrings: true,
      splitStringsChunkLength: 10,
      stringArray: true,
      stringArrayCallsTransform: true,
      stringArrayEncoding: ["base64"],
      stringArrayThreshold: 0.75,
      transformObjectKeys: true,
      unicodeEscapeSequence: false,
    },
    // Only obfuscate JS/TS source — never HTML/CSS/JSON/WASM (the obfuscator
    // crashes on non-JS input with "Unexpected token (1:0)"). The extension
    // entries are .html files; Vite passes them through transform() too.
    include: [/src\/(sidebar|content|lib|background)\/.*\.(ts|tsx|js|mjs)$/],
    exclude: [
      /node_modules/,
      /offscreen/,
      /vendor/,
      /chunk-/,
      /\.html$/,
      /\.css$/,
      /\.json$/,
      /\.wasm$/,
    ],
  }) as Plugin;
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";

export default defineConfig(async ({ mode }) => {
  const isProd = mode === "production";
  // Disable all production plugins - they're corrupting Phoenix library code
  const productionPlugins: Plugin[] = [];

  const realDir = fs.realpathSync(__dirname);
  return {
    root: realDir,
    plugins: [
      react(),
      crx({ manifest }),
      cleanupPublicDupPlugin(),
      injectKeyPlugin(),
      copyTransformersWasmPlugin(),
      copyTreeSitterWasmPlugin(),
      ...productionPlugins,
    ],
    server: {
      host: "localhost",
      port: 5173,
      strictPort: true,
      cors: true,
      origin: "http://localhost:5173",
    },
    build: {
      rollupOptions: {
        input: {
          "src/content/claude": path.resolve(__dirname, "src/content/claude.ts"),
          "src/content/chatgpt": path.resolve(__dirname, "src/content/chatgpt.ts"),
          "src/content/gemini": path.resolve(__dirname, "src/content/gemini.ts"),
          "src/content/grok": path.resolve(__dirname, "src/content/grok.ts"),
          "src/content/perplexity": path.resolve(__dirname, "src/content/perplexity.ts"),
          "src/content/deepseek": path.resolve(__dirname, "src/content/deepseek.ts"),
          "src/content/fetch-interceptor": path.resolve(__dirname, "src/content/fetch-interceptor.ts"),
          "src/content/interceptor-bridge": path.resolve(__dirname, "src/content/interceptor-bridge.ts"),
          "src/content/sidebar-toggle/toggle": path.resolve(__dirname, "src/content/sidebar-toggle/toggle.ts"),
          "src/content/web-sync": path.resolve(__dirname, "src/content/web-sync.ts"),
        },
        output: {
          // @xenova/transformers is bundled into the offscreen chunk via
          // transformers-loader.ts static import. No manual chunk split needed.
        },
      },
      target: "esnext",
      // Disable minification - terser fails on Phoenix library code
      minify: false,
      // Never emit source maps in production
      sourcemap: false,
    },
    resolve: {
      alias: { 
        "@": path.resolve(fs.realpathSync(__dirname), "src"),
      },
    },
  };
});
