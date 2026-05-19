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
import { createRequire } from "module";

// Resolve @xenova/transformers' pre-built ESM bundle path. The package's
// `main` field points at `./src/transformers.js`, which transitively imports
// `onnxruntime-web`. Under pnpm's hoisted layout that import isn't reachable
// from packages/browser-extension/node_modules, so Rollup silently bails on
// bundling and leaves `import("@xenova/transformers")` as a bare specifier,
// which Chrome's offscreen document then cannot resolve at runtime.
// The pre-built `dist/transformers.min.js` is a self-contained ESM webpack
// bundle with onnxruntime-web inlined — aliasing to it sidesteps the source
// resolution chain entirely.
const _require = createRequire(import.meta.url);
const XENOVA_PKG_JSON = _require.resolve("@xenova/transformers/package.json");
const XENOVA_DIST_DIR = path.resolve(path.dirname(XENOVA_PKG_JSON), "dist");
const XENOVA_DIST_BUNDLE = path.resolve(XENOVA_DIST_DIR, "transformers.min.js");

// Copies the ONNX runtime WASM files shipped with @xenova/transformers/dist
// into dist/wasm/ so onnxruntime-web (loaded transitively by transformers)
// can find them via env.backends.onnx.wasm.wasmPaths set in model-registry.
function copyOnnxWasmPlugin(): Plugin {
  return {
    name: "copy-onnx-wasm",
    apply: "build",
    closeBundle() {
      const outDir = path.resolve(__dirname, "dist/wasm");
      fs.mkdirSync(outDir, { recursive: true });
      const wasms = fs.readdirSync(XENOVA_DIST_DIR).filter((f) => f.endsWith(".wasm"));
      for (const f of wasms) {
        fs.copyFileSync(path.join(XENOVA_DIST_DIR, f), path.join(outDir, f));
      }
      // ort-wasm-threaded.worker.js is needed for multi-threaded WASM inference
      const workerJs = "ort-wasm-threaded.worker.js";
      const workerSrc = path.join(XENOVA_DIST_DIR, workerJs);
      if (fs.existsSync(workerSrc)) {
        fs.copyFileSync(workerSrc, path.join(outDir, workerJs));
      }
      console.log(`[vite:copy-onnx-wasm] copied ${wasms.length} wasm file(s) to dist/wasm/`);
      // ── transformers bundle → dist/transformers/ ─────────────────────────
      // Loaded at runtime via chrome.runtime.getURL("transformers/transformers.min.js")
      // using /* @vite-ignore */ dynamic import so Rollup never sees the bare
      // specifier and Chrome resolves the extension-local file directly.
      const tfDir = path.resolve(__dirname, "dist/transformers");
      fs.mkdirSync(tfDir, { recursive: true });
      fs.copyFileSync(XENOVA_DIST_BUNDLE, path.join(tfDir, "transformers.min.js"));
      console.log("[vite:copy-onnx-wasm] copied transformers.min.js to dist/transformers/");
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
      // Third-party code like Dexie uses console.warn with long comma
      // expressions; the greedy [^;]* regex consumes them and corrupts
      // the output (e.g. the Dexie PR1398 recovery ternary becomes
      // `PR1398_maxLoop?(` with the rest stripped → SyntaxError).
      if (!chunk.facadeModuleId) return null;
      const result = code.replace(
        /console\.(log|warn|debug)\(\s*(["'`][^"'`\n]*["'`])[^;]*\);?/g,
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
      /embedding\.worker/,
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
  const productionPlugins: Plugin[] = isProd
    ? [stripNonCmLogs(), await obfuscatorPlugin()]
    : [];

  return {
    plugins: [
      react(),
      crx({ manifest }),
      copyOnnxWasmPlugin(),
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
          sidebar: "src/sidebar/index.html",
          offscreen: "src/offscreen/offscreen.html",
          "src/content/claude": "src/content/claude.ts",
          "src/content/chatgpt": "src/content/chatgpt.ts",
          "src/content/gemini": "src/content/gemini.ts",
          "src/content/grok": "src/content/grok.ts",
          "src/content/perplexity": "src/content/perplexity.ts",
          "src/content/deepseek": "src/content/deepseek.ts",
          "src/content/fetch-interceptor": "src/content/fetch-interceptor.ts",
          "src/content/interceptor-bridge": "src/content/interceptor-bridge.ts",
          "src/content/sidebar-toggle/toggle": "src/content/sidebar-toggle/toggle.ts",
        },
        output: {
          // Isolate @xenova/transformers + onnxruntime into a dedicated chunk.
          // The service worker MUST NOT load this chunk — model loading is
          // offscreen-only. The static import chain from SW was broken in
          // semantic-index/index.ts; this manualChunks is defence-in-depth.
          manualChunks(id: string) {
            if (
              id.includes("@xenova/transformers") ||
              id.includes("onnxruntime-web") ||
              id.includes("onnxruntime")
            ) {
              return "transformers-vendor";
            }
          },
        },
      },
      target: "esnext",
      // Task 5: obfuscator (compact:true) handles minification + comment
      // stripping in production. Running Vite's built-in terser AFTER the
      // obfuscator double-parses the string-array IIFE and fails with
      // "Unexpected token". Disable Vite minify in prod — obfuscator owns it.
      minify: false,
      // Task 5: never emit source maps in production
      sourcemap: false,
    },
    resolve: {
      alias: { "@": path.resolve(__dirname, "src") },
    },
  };
});
