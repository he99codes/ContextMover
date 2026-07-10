// vite.config.ts
import { defineConfig } from "file:///C:/Users/priyanshu/Desktop/context_mover/ContextMover-main/packages/browser-extension/node_modules/.pnpm/vite@5.4.21_@types+node@20.19.39_terser@5.48.0/node_modules/vite/dist/node/index.js";
import react from "file:///C:/Users/priyanshu/Desktop/context_mover/ContextMover-main/packages/browser-extension/node_modules/.pnpm/@vitejs+plugin-react@4.7.0__58874aa4082bece7e2f84f098b4c20eb/node_modules/@vitejs/plugin-react/dist/index.js";
import { crx } from "file:///C:/Users/priyanshu/Desktop/context_mover/ContextMover-main/packages/browser-extension/node_modules/.pnpm/@crxjs+vite-plugin@2.4.0_vi_91b6d36ab441254c01e7d8b4e4afa5b6/node_modules/@crxjs/vite-plugin/dist/index.mjs";

// manifest.json
var manifest_default = {
  manifest_version: 3,
  name: "Context Mover",
  version: "1.0.2",
  description: "Never lose coding context again. One layer. Any agent. Zero friction.",
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyApPGjeX14mNzHljCE/yzVN8OYGv+MVLMBovRArlGu7Y+i/N8r39s5o1kfk4pR4/5+SYWHRnO+3gDst6fhiWd/uSnUXhbIiSR4xs23KHnK+zmi6FP2TQAiIpIliE7J2/jJAHusAX9bEcr+qsGHIwUEksaWO6m7AhNDGsAkjY37Dv0fgY4OelKC5bG+dRk3JPyYzvUu4YG6eeQHsOd+jTinHcIf7KXEaxzv+X/yPVjJg77xHZFKaamkXwLEBrv8+5prGcvmtrPlXh1uTq1ExTrkpMbvO7cDbd94v55CcuTpa/GTf3lURwiV2Ibamf26VyacVn1AmGnXS+8VAWBdzneQIDAQAB",
  permissions: [
    "activeTab",
    "scripting",
    "storage",
    "unlimitedStorage",
    "tabs",
    "sidePanel",
    "downloads",
    "offscreen",
    "identity",
    "alarms"
  ],
  oauth2: {
    client_id: "537316078537-hcpqdq1jsh3eh748071u0q4id7j1iivd.apps.googleusercontent.com",
    scopes: [
      "https://www.googleapis.com/auth/drive.appdata",
      "https://www.googleapis.com/auth/userinfo.email"
    ]
  },
  host_permissions: [
    "https://claude.ai/*",
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://gemini.google.com/*",
    "https://grok.com/*",
    "https://grok.x.ai/*",
    "https://www.perplexity.ai/*",
    "https://chat.deepseek.com/*",
    "https://contextmover.com/*",
    "https://*.contextmover.com/*",
    "https://huggingface.co/*",
    "https://*.huggingface.co/*",
    "https://cdn.jsdelivr.net/*",
    "https://www.googleapis.com/*",
    "https://accounts.google.com/*",
    "https://*.supabase.co/*"
  ],
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module"
  },
  content_scripts: [
    {
      matches: [
        "https://claude.ai/*",
        "https://chatgpt.com/*",
        "https://chat.openai.com/*",
        "https://gemini.google.com/*",
        "https://grok.com/*",
        "https://grok.x.ai/*",
        "https://www.perplexity.ai/*",
        "https://chat.deepseek.com/*"
      ],
      js: [
        "src/content/fetch-interceptor.ts"
      ],
      run_at: "document_start",
      world: "MAIN"
    },
    {
      matches: [
        "https://claude.ai/*",
        "https://chatgpt.com/*",
        "https://chat.openai.com/*",
        "https://gemini.google.com/*",
        "https://grok.com/*",
        "https://grok.x.ai/*",
        "https://www.perplexity.ai/*",
        "https://chat.deepseek.com/*"
      ],
      js: [
        "src/content/interceptor-bridge.ts"
      ],
      run_at: "document_start"
    },
    {
      matches: [
        "https://claude.ai/*"
      ],
      js: [
        "src/content/claude.ts"
      ],
      run_at: "document_start",
      all_frames: false
    },
    {
      matches: [
        "https://chatgpt.com/*",
        "https://chat.openai.com/*"
      ],
      js: [
        "src/content/chatgpt.ts"
      ],
      run_at: "document_start"
    },
    {
      matches: [
        "https://gemini.google.com/*"
      ],
      js: [
        "src/content/gemini.ts"
      ],
      run_at: "document_start"
    },
    {
      matches: [
        "https://grok.com/*",
        "https://grok.x.ai/*"
      ],
      js: [
        "src/content/grok.ts"
      ],
      run_at: "document_idle"
    },
    {
      matches: [
        "https://www.perplexity.ai/*"
      ],
      js: [
        "src/content/perplexity.ts"
      ],
      run_at: "document_idle"
    },
    {
      matches: [
        "https://chat.deepseek.com/*"
      ],
      js: [
        "src/content/deepseek.ts"
      ],
      run_at: "document_idle"
    },
    {
      matches: [
        "https://claude.ai/*",
        "https://chatgpt.com/*",
        "https://chat.openai.com/*",
        "https://gemini.google.com/*",
        "https://grok.com/*",
        "https://grok.x.ai/*",
        "https://www.perplexity.ai/*",
        "https://chat.deepseek.com/*"
      ],
      js: [
        "src/content/sidebar-toggle/toggle.ts"
      ],
      run_at: "document_idle"
    },
    {
      matches: ["https://*/*", "http://*/*"],
      exclude_matches: [
        "https://claude.ai/*",
        "https://chatgpt.com/*",
        "https://chat.openai.com/*",
        "https://gemini.google.com/*",
        "https://grok.com/*",
        "https://grok.x.ai/*",
        "https://www.perplexity.ai/*",
        "https://chat.deepseek.com/*"
      ],
      js: [
        "src/content/sidebar-toggle/toggle.ts"
      ],
      run_at: "document_idle",
      all_frames: false
    }
  ],
  action: {
    default_title: "ContextMover",
    default_icon: {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  side_panel: {
    default_path: "src/sidebar/index.html"
  },
  web_accessible_resources: [
    {
      resources: [
        "src/content/fetch-interceptor.ts",
        "assets/*.js",
        "assets/*.css",
        "assets/*.png",
        "assets/*.svg",
        "assets/*.woff2",
        "wasm/*"
      ],
      matches: [
        "https://claude.ai/*",
        "https://chatgpt.com/*",
        "https://chat.openai.com/*",
        "https://gemini.google.com/*",
        "https://grok.com/*",
        "https://grok.x.ai/*",
        "https://www.perplexity.ai/*",
        "https://chat.deepseek.com/*"
      ]
    },
    {
      resources: [
        "grammars/web-tree-sitter.wasm"
      ],
      matches: [
        "https://claude.ai/*",
        "https://chatgpt.com/*",
        "https://chat.openai.com/*",
        "https://gemini.google.com/*",
        "https://grok.com/*",
        "https://grok.x.ai/*",
        "https://www.perplexity.ai/*",
        "https://chat.deepseek.com/*"
      ]
    }
  ],
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://contextmover.com https://*.contextmover.com https://huggingface.co https://*.huggingface.co https://cdn-lfs.huggingface.co https://cdn-lfs-us-1.huggingface.co https://*.hf.space https://cdn.jsdelivr.net https://*.jsdelivr.net https://www.googleapis.com https://*.xethub.hf.co; form-action 'none'; frame-src 'none'"
  },
  icons: {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
};

// vite.config.ts
import path from "path";
import fs from "fs";
var __vite_injected_original_dirname = "C:\\Users\\priyanshu\\Desktop\\context_mover\\ContextMover-main\\packages\\browser-extension";
function cleanupPublicDupPlugin() {
  return {
    name: "cleanup-public-dup",
    apply: "build",
    closeBundle() {
      const publicDup = path.resolve(__vite_injected_original_dirname, "dist/public");
      if (fs.existsSync(publicDup)) {
        fs.rmSync(publicDup, { recursive: true, force: true });
        console.log("[vite:cleanup-public-dup] removed duplicate dist/public/");
      }
    }
  };
}
function copyTreeSitterWasmPlugin() {
  return {
    name: "copy-tree-sitter-wasm",
    closeBundle() {
      const srcNew = path.resolve(__vite_injected_original_dirname, "node_modules/web-tree-sitter/web-tree-sitter.wasm");
      const srcOld = path.resolve(__vite_injected_original_dirname, "node_modules/web-tree-sitter/tree-sitter.wasm");
      const src = fs.existsSync(srcNew) ? srcNew : srcOld;
      const dest = path.resolve(__vite_injected_original_dirname, "dist");
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dest, "tree-sitter.wasm"));
        console.log(`[copy-tree-sitter-wasm] copied tree-sitter.wasm to dist/`);
      } else {
        console.warn(`[copy-tree-sitter-wasm] source file not found: ${src}`);
      }
    }
  };
}
function injectKeyPlugin() {
  return {
    name: "inject-manifest-key",
    apply: "build",
    closeBundle() {
      const distManifest = path.resolve(__vite_injected_original_dirname, "dist/manifest.json");
      if (!fs.existsSync(distManifest)) return;
      const mf = JSON.parse(fs.readFileSync(distManifest, "utf-8"));
      if (!mf.key && manifest_default.key) {
        mf.key = manifest_default.key;
        fs.writeFileSync(distManifest, JSON.stringify(mf, null, 2));
        console.log("[inject-manifest-key] re-injected key into dist/manifest.json");
      }
    }
  };
}
function copyTransformersWasmPlugin() {
  return {
    name: "copy-transformers-wasm",
    closeBundle() {
      const src = path.resolve(
        __vite_injected_original_dirname,
        "node_modules/@xenova/transformers/dist"
      );
      const dest = path.resolve(__vite_injected_original_dirname, "dist/assets");
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      const files = fs.readdirSync(src).filter((f) => f === "ort-wasm-simd.wasm");
      for (const file of files) {
        fs.copyFileSync(path.join(src, file), path.join(dest, file));
        console.log(`[copy-transformers-wasm] copied ${file}`);
      }
    }
  };
}
var IS_PRODUCTION = process.env.NODE_ENV === "production";
var vite_config_default = defineConfig(async ({ mode }) => {
  const isProd = mode === "production";
  const productionPlugins = [];
  return {
    plugins: [
      react(),
      crx({ manifest: manifest_default }),
      cleanupPublicDupPlugin(),
      injectKeyPlugin(),
      copyTransformersWasmPlugin(),
      copyTreeSitterWasmPlugin(),
      ...productionPlugins
    ],
    server: {
      host: "localhost",
      port: 5173,
      strictPort: true,
      cors: true,
      origin: "http://localhost:5173"
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
          "src/content/sidebar-toggle/toggle": "src/content/sidebar-toggle/toggle.ts"
        },
        output: {
          // @xenova/transformers is bundled into the offscreen chunk via
          // transformers-loader.ts static import. No manual chunk split needed.
        }
      },
      target: "esnext",
      // Disable minification - terser fails on Phoenix library code
      minify: false,
      // Never emit source maps in production
      sourcemap: false
    },
    resolve: {
      alias: {
        "@": path.resolve(__vite_injected_original_dirname, "src")
      }
    }
  };
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiLCAibWFuaWZlc3QuanNvbiJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkM6XFxcXFVzZXJzXFxcXHByaXlhbnNodVxcXFxEZXNrdG9wXFxcXGNvbnRleHRfbW92ZXJcXFxcQ29udGV4dE1vdmVyLW1haW5cXFxccGFja2FnZXNcXFxcYnJvd3Nlci1leHRlbnNpb25cIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIkM6XFxcXFVzZXJzXFxcXHByaXlhbnNodVxcXFxEZXNrdG9wXFxcXGNvbnRleHRfbW92ZXJcXFxcQ29udGV4dE1vdmVyLW1haW5cXFxccGFja2FnZXNcXFxcYnJvd3Nlci1leHRlbnNpb25cXFxcdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0M6L1VzZXJzL3ByaXlhbnNodS9EZXNrdG9wL2NvbnRleHRfbW92ZXIvQ29udGV4dE1vdmVyLW1haW4vcGFja2FnZXMvYnJvd3Nlci1leHRlbnNpb24vdml0ZS5jb25maWcudHNcIjsvKipcbiAqIENvcHlyaWdodCBcdTAwQTkgMjAyNiBDb250ZXh0TW92ZXIuIEFsbCByaWdodHMgcmVzZXJ2ZWQuXG4gKiBVbmF1dGhvcml6ZWQgY29weWluZywgbW9kaWZpY2F0aW9uLCBkaXN0cmlidXRpb24sIG9yIHVzZVxuICogb2YgdGhpcyBzb2Z0d2FyZSwgdmlhIGFueSBtZWRpdW0sIGlzIHN0cmljdGx5IHByb2hpYml0ZWQuXG4gKiBQcm9wcmlldGFyeSBhbmQgY29uZmlkZW50aWFsLlxuICovXG5cbmltcG9ydCB7IGRlZmluZUNvbmZpZywgdHlwZSBQbHVnaW4gfSBmcm9tIFwidml0ZVwiO1xuaW1wb3J0IHJlYWN0IGZyb20gXCJAdml0ZWpzL3BsdWdpbi1yZWFjdFwiO1xuaW1wb3J0IHsgY3J4IH0gZnJvbSBcIkBjcnhqcy92aXRlLXBsdWdpblwiO1xuaW1wb3J0IG1hbmlmZXN0IGZyb20gXCIuL21hbmlmZXN0Lmpzb25cIjtcbmltcG9ydCBwYXRoIGZyb20gXCJwYXRoXCI7XG5pbXBvcnQgZnMgZnJvbSBcImZzXCI7XG5cbi8vIFJlbW92ZSBjcngtcGx1Z2luIGR1cGxpY2F0ZSBvZiBwdWJsaWMvIGFzc2V0cy5cbmZ1bmN0aW9uIGNsZWFudXBQdWJsaWNEdXBQbHVnaW4oKTogUGx1Z2luIHtcbiAgcmV0dXJuIHtcbiAgICBuYW1lOiBcImNsZWFudXAtcHVibGljLWR1cFwiLFxuICAgIGFwcGx5OiBcImJ1aWxkXCIsXG4gICAgY2xvc2VCdW5kbGUoKSB7XG4gICAgICBjb25zdCBwdWJsaWNEdXAgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcImRpc3QvcHVibGljXCIpO1xuICAgICAgaWYgKGZzLmV4aXN0c1N5bmMocHVibGljRHVwKSkge1xuICAgICAgICBmcy5ybVN5bmMocHVibGljRHVwLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW3ZpdGU6Y2xlYW51cC1wdWJsaWMtZHVwXSByZW1vdmVkIGR1cGxpY2F0ZSBkaXN0L3B1YmxpYy9cIik7XG4gICAgICB9XG4gICAgfSxcbiAgfTtcbn1cblxuLy8gQ29weSB3ZWItdHJlZS1zaXR0ZXIgV0FTTSBydW50aW1lIGZpbGUgdG8gZGlzdC8gcm9vdC5cbi8vIFRoZSBtYWluIHJ1bnRpbWUgZmlsZSBtdXN0IGJlIGF0IHRoZSBkaXN0IHJvb3QgdG8gbWF0Y2ggY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCd0cmVlLXNpdHRlci53YXNtJykuXG5mdW5jdGlvbiBjb3B5VHJlZVNpdHRlcldhc21QbHVnaW4oKTogUGx1Z2luIHtcbiAgcmV0dXJuIHtcbiAgICBuYW1lOiBcImNvcHktdHJlZS1zaXR0ZXItd2FzbVwiLFxuICAgIGNsb3NlQnVuZGxlKCkge1xuICAgICAgLy8gMC4yNi54IHNoaXBzIHdlYi10cmVlLXNpdHRlci53YXNtOyAwLjIwLnggc2hpcHMgdHJlZS1zaXR0ZXIud2FzbSBcdTIwMTQgdHJ5IGJvdGguXG4gICAgICBjb25zdCBzcmNOZXcgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcIm5vZGVfbW9kdWxlcy93ZWItdHJlZS1zaXR0ZXIvd2ViLXRyZWUtc2l0dGVyLndhc21cIik7XG4gICAgICBjb25zdCBzcmNPbGQgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcIm5vZGVfbW9kdWxlcy93ZWItdHJlZS1zaXR0ZXIvdHJlZS1zaXR0ZXIud2FzbVwiKTtcbiAgICAgIGNvbnN0IHNyYyA9IGZzLmV4aXN0c1N5bmMoc3JjTmV3KSA/IHNyY05ldyA6IHNyY09sZDtcbiAgICAgIGNvbnN0IGRlc3QgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcImRpc3RcIik7XG5cbiAgICAgIGlmICghZnMuZXhpc3RzU3luYyhkZXN0KSkgZnMubWtkaXJTeW5jKGRlc3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgICBpZiAoZnMuZXhpc3RzU3luYyhzcmMpKSB7XG4gICAgICAgIGZzLmNvcHlGaWxlU3luYyhzcmMsIHBhdGguam9pbihkZXN0LCBcInRyZWUtc2l0dGVyLndhc21cIikpO1xuICAgICAgICBjb25zb2xlLmxvZyhgW2NvcHktdHJlZS1zaXR0ZXItd2FzbV0gY29waWVkIHRyZWUtc2l0dGVyLndhc20gdG8gZGlzdC9gKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNvbGUud2FybihgW2NvcHktdHJlZS1zaXR0ZXItd2FzbV0gc291cmNlIGZpbGUgbm90IGZvdW5kOiAke3NyY31gKTtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xufVxuXG4vLyBbT0FVVEgtRklYXSBAY3J4anMvdml0ZS1wbHVnaW4gc3RyaXBzIHRoZSBcImtleVwiIGZpZWxkIGZyb20gbWFuaWZlc3QuanNvbi5cbi8vIFRoaXMgcGx1Z2luIHJlLWluamVjdHMgaXQgYWZ0ZXIgYnVpbGQgc28gdGhlIGV4dGVuc2lvbiBJRCBtYXRjaGVzIHRoZVxuLy8gT0F1dGggcmVkaXJlY3QgVVJJIGNvbmZpZ3VyZWQgaW4gR29vZ2xlIENsb3VkIENvbnNvbGUuXG5mdW5jdGlvbiBpbmplY3RLZXlQbHVnaW4oKTogUGx1Z2luIHtcbiAgcmV0dXJuIHtcbiAgICBuYW1lOiBcImluamVjdC1tYW5pZmVzdC1rZXlcIixcbiAgICBhcHBseTogXCJidWlsZFwiLFxuICAgIGNsb3NlQnVuZGxlKCkge1xuICAgICAgY29uc3QgZGlzdE1hbmlmZXN0ID0gcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCJkaXN0L21hbmlmZXN0Lmpzb25cIik7XG4gICAgICBpZiAoIWZzLmV4aXN0c1N5bmMoZGlzdE1hbmlmZXN0KSkgcmV0dXJuO1xuICAgICAgY29uc3QgbWYgPSBKU09OLnBhcnNlKGZzLnJlYWRGaWxlU3luYyhkaXN0TWFuaWZlc3QsIFwidXRmLThcIikpO1xuICAgICAgaWYgKCFtZi5rZXkgJiYgKG1hbmlmZXN0IGFzIGFueSkua2V5KSB7XG4gICAgICAgIG1mLmtleSA9IChtYW5pZmVzdCBhcyBhbnkpLmtleTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhkaXN0TWFuaWZlc3QsIEpTT04uc3RyaW5naWZ5KG1mLCBudWxsLCAyKSk7XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW2luamVjdC1tYW5pZmVzdC1rZXldIHJlLWluamVjdGVkIGtleSBpbnRvIGRpc3QvbWFuaWZlc3QuanNvblwiKTtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBjb3B5VHJhbnNmb3JtZXJzV2FzbVBsdWdpbigpOiBQbHVnaW4ge1xuICByZXR1cm4ge1xuICAgIG5hbWU6IFwiY29weS10cmFuc2Zvcm1lcnMtd2FzbVwiLFxuICAgIGNsb3NlQnVuZGxlKCkge1xuICAgICAgY29uc3Qgc3JjID0gcGF0aC5yZXNvbHZlKFxuICAgICAgICBfX2Rpcm5hbWUsXG4gICAgICAgIFwibm9kZV9tb2R1bGVzL0B4ZW5vdmEvdHJhbnNmb3JtZXJzL2Rpc3RcIlxuICAgICAgKTtcbiAgICAgIGNvbnN0IGRlc3QgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcImRpc3QvYXNzZXRzXCIpO1xuXG4gICAgICBpZiAoIWZzLmV4aXN0c1N5bmMoZGVzdCkpIGZzLm1rZGlyU3luYyhkZXN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgICAgLy8gT25seSBjb3B5IHRoZSBTSU1EIHZhcmlhbnQgXHUyMDE0IENocm9tZSA4OSsgYWx3YXlzIHN1cHBvcnRzIFNJTUQsXG4gICAgICAvLyBhbmQgc2hpcHBpbmcgYWxsIDQgdmFyaWFudHMgd2FzdGVzIH4yOCBNQi4gU2luZ2xlLXRocmVhZGVkIFNJTURcbiAgICAgIC8vIGlzIHN1ZmZpY2llbnQgZm9yIE1pbmlMTSBpbmZlcmVuY2UuXG4gICAgICBjb25zdCBmaWxlcyA9IGZzLnJlYWRkaXJTeW5jKHNyYylcbiAgICAgICAgLmZpbHRlcigoZikgPT4gZiA9PT0gXCJvcnQtd2FzbS1zaW1kLndhc21cIik7XG4gICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcbiAgICAgICAgZnMuY29weUZpbGVTeW5jKHBhdGguam9pbihzcmMsIGZpbGUpLCBwYXRoLmpvaW4oZGVzdCwgZmlsZSkpO1xuICAgICAgICBjb25zb2xlLmxvZyhgW2NvcHktdHJhbnNmb3JtZXJzLXdhc21dIGNvcGllZCAke2ZpbGV9YCk7XG4gICAgICB9XG4gICAgfSxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIFByb2R1Y3Rpb24tb25seTogc3RyaXAgY29uc29sZS5sb2cvd2Fybi9kZWJ1ZyB0aGF0IGxhY2sgW0NNOl0vW0NvbnRleHRNb3Zlcl0gdGFncy5cbi8vIFdvcmtzIGF0IHJlbmRlckNodW5rIGxldmVsIHNvIGl0IGNhdGNoZXMgdHJlZS1zaGFrZW4gY29tcGlsZWQgb3V0cHV0LlxuLy8gTXVsdGktbGluZSBjYWxscyBhbmQgdGVtcGxhdGUtbGl0ZXJhbCBjYWxscyBhcmUgbGVmdCBhcy1pcyAoc2FmZSBkZWZhdWx0KS5cbmZ1bmN0aW9uIHN0cmlwTm9uQ21Mb2dzKCk6IFBsdWdpbiB7XG4gIHJldHVybiB7XG4gICAgbmFtZTogXCJzdHJpcC1ub24tY20tbG9nc1wiLFxuICAgIGVuZm9yY2U6IFwicG9zdFwiLFxuICAgIHJlbmRlckNodW5rKGNvZGUsIGNodW5rKSB7XG4gICAgICAvLyBTa2lwIHNoYXJlZCAvIHZlbmRvciBjaHVua3MgKGZhY2FkZU1vZHVsZUlkIGlzIG51bGwgZm9yIHRob3NlKS5cbiAgICAgIC8vIEFsc28gc2tpcCBvZmZzY3JlZW4gY2h1bmtzIFx1MjAxNCB0aGV5IGNvbnRhaW4gdGhlIGJ1bmRsZWQgdHJhbnNmb3JtZXJzXG4gICAgICAvLyBtaW5pZmllZCBsaWJyYXJ5IHdoaWNoIHRoaXMgcmVnZXggY2FuIGFjY2lkZW50YWxseSBjb3JydXB0LlxuICAgICAgaWYgKCFjaHVuay5mYWNhZGVNb2R1bGVJZCB8fCBjaHVuay5mYWNhZGVNb2R1bGVJZC5pbmNsdWRlcyhcIm9mZnNjcmVlblwiKSkgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCByZXN1bHQgPSBjb2RlLnJlcGxhY2UoXG4gICAgICAgIC9jb25zb2xlXFwuKGxvZ3x3YXJufGRlYnVnKVxcKFxccyooW1wiJ2BdW15cIidgXFxuXSpbXCInYF0pW14pXSpcXCk7Py9nLFxuICAgICAgICAobWF0Y2gpID0+ICgvXFxbKD86Q006fENvbnRleHRNb3ZlcikvLnRlc3QobWF0Y2gpID8gbWF0Y2ggOiBcIlwiKVxuICAgICAgKTtcbiAgICAgIHJldHVybiByZXN1bHQgPT09IGNvZGUgPyBudWxsIDogeyBjb2RlOiByZXN1bHQsIG1hcDogbnVsbCB9O1xuICAgIH0sXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBQcm9kdWN0aW9uLW9ubHk6IGphdmFzY3JpcHQtb2JmdXNjYXRvciB2aWEgcm9sbHVwLXBsdWdpbi1vYmZ1c2NhdG9yLlxuLy8gRXhjbHVkZWQgY2h1bmtzOiBlbWJlZGRpbmcgd29ya2VyIChXQVNNLWhlYXZ5LCBwZXJmLWNyaXRpY2FsKSwgdmVuZG9yXG4vLyBidW5kbGVzLCBhbmQgb2Zmc2NyZWVuIGRvYyAoc3RhYmlsaXR5IGJvdW5kYXJ5IHdpdGggV0FTTSBtb2R1bGVzKS5cbmFzeW5jIGZ1bmN0aW9uIG9iZnVzY2F0b3JQbHVnaW4oKTogUHJvbWlzZTxQbHVnaW4+IHtcbiAgY29uc3QgeyBkZWZhdWx0OiBvYmZ1c2NhdG9yUm9sbHVwIH0gPSBhd2FpdCBpbXBvcnQoXCJyb2xsdXAtcGx1Z2luLW9iZnVzY2F0b3JcIik7XG4gIHJldHVybiBvYmZ1c2NhdG9yUm9sbHVwKHtcbiAgICBvcHRpb25zOiB7XG4gICAgICBjb21wYWN0OiB0cnVlLFxuICAgICAgY29udHJvbEZsb3dGbGF0dGVuaW5nOiB0cnVlLFxuICAgICAgY29udHJvbEZsb3dGbGF0dGVuaW5nVGhyZXNob2xkOiAwLjc1LFxuICAgICAgZGVhZENvZGVJbmplY3Rpb246IHRydWUsXG4gICAgICBkZWFkQ29kZUluamVjdGlvblRocmVzaG9sZDogMC40LFxuICAgICAgZGVidWdQcm90ZWN0aW9uOiBmYWxzZSxcbiAgICAgIGRpc2FibGVDb25zb2xlT3V0cHV0OiBmYWxzZSxcbiAgICAgIGlkZW50aWZpZXJOYW1lc0dlbmVyYXRvcjogXCJoZXhhZGVjaW1hbFwiLFxuICAgICAgcmVuYW1lR2xvYmFsczogZmFsc2UsXG4gICAgICByb3RhdGVTdHJpbmdBcnJheTogdHJ1ZSxcbiAgICAgIHNlbGZEZWZlbmRpbmc6IGZhbHNlLFxuICAgICAgc2h1ZmZsZVN0cmluZ0FycmF5OiB0cnVlLFxuICAgICAgc3BsaXRTdHJpbmdzOiB0cnVlLFxuICAgICAgc3BsaXRTdHJpbmdzQ2h1bmtMZW5ndGg6IDEwLFxuICAgICAgc3RyaW5nQXJyYXk6IHRydWUsXG4gICAgICBzdHJpbmdBcnJheUNhbGxzVHJhbnNmb3JtOiB0cnVlLFxuICAgICAgc3RyaW5nQXJyYXlFbmNvZGluZzogW1wiYmFzZTY0XCJdLFxuICAgICAgc3RyaW5nQXJyYXlUaHJlc2hvbGQ6IDAuNzUsXG4gICAgICB0cmFuc2Zvcm1PYmplY3RLZXlzOiB0cnVlLFxuICAgICAgdW5pY29kZUVzY2FwZVNlcXVlbmNlOiBmYWxzZSxcbiAgICB9LFxuICAgIC8vIE9ubHkgb2JmdXNjYXRlIEpTL1RTIHNvdXJjZSBcdTIwMTQgbmV2ZXIgSFRNTC9DU1MvSlNPTi9XQVNNICh0aGUgb2JmdXNjYXRvclxuICAgIC8vIGNyYXNoZXMgb24gbm9uLUpTIGlucHV0IHdpdGggXCJVbmV4cGVjdGVkIHRva2VuICgxOjApXCIpLiBUaGUgZXh0ZW5zaW9uXG4gICAgLy8gZW50cmllcyBhcmUgLmh0bWwgZmlsZXM7IFZpdGUgcGFzc2VzIHRoZW0gdGhyb3VnaCB0cmFuc2Zvcm0oKSB0b28uXG4gICAgaW5jbHVkZTogWy9zcmNcXC8oc2lkZWJhcnxjb250ZW50fGxpYnxiYWNrZ3JvdW5kKVxcLy4qXFwuKHRzfHRzeHxqc3xtanMpJC9dLFxuICAgIGV4Y2x1ZGU6IFtcbiAgICAgIC9ub2RlX21vZHVsZXMvLFxuICAgICAgL29mZnNjcmVlbi8sXG4gICAgICAvdmVuZG9yLyxcbiAgICAgIC9jaHVuay0vLFxuICAgICAgL1xcLmh0bWwkLyxcbiAgICAgIC9cXC5jc3MkLyxcbiAgICAgIC9cXC5qc29uJC8sXG4gICAgICAvXFwud2FzbSQvLFxuICAgIF0sXG4gIH0pIGFzIFBsdWdpbjtcbn1cblxuY29uc3QgSVNfUFJPRFVDVElPTiA9IHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSBcInByb2R1Y3Rpb25cIjtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKGFzeW5jICh7IG1vZGUgfSkgPT4ge1xuICBjb25zdCBpc1Byb2QgPSBtb2RlID09PSBcInByb2R1Y3Rpb25cIjtcbiAgLy8gRGlzYWJsZSBhbGwgcHJvZHVjdGlvbiBwbHVnaW5zIC0gdGhleSdyZSBjb3JydXB0aW5nIFBob2VuaXggbGlicmFyeSBjb2RlXG4gIGNvbnN0IHByb2R1Y3Rpb25QbHVnaW5zOiBQbHVnaW5bXSA9IFtdO1xuXG4gIHJldHVybiB7XG4gICAgcGx1Z2luczogW1xuICAgICAgcmVhY3QoKSxcbiAgICAgIGNyeCh7IG1hbmlmZXN0IH0pLFxuICAgICAgY2xlYW51cFB1YmxpY0R1cFBsdWdpbigpLFxuICAgICAgaW5qZWN0S2V5UGx1Z2luKCksXG4gICAgICBjb3B5VHJhbnNmb3JtZXJzV2FzbVBsdWdpbigpLFxuICAgICAgY29weVRyZWVTaXR0ZXJXYXNtUGx1Z2luKCksXG4gICAgICAuLi5wcm9kdWN0aW9uUGx1Z2lucyxcbiAgICBdLFxuICAgIHNlcnZlcjoge1xuICAgICAgaG9zdDogXCJsb2NhbGhvc3RcIixcbiAgICAgIHBvcnQ6IDUxNzMsXG4gICAgICBzdHJpY3RQb3J0OiB0cnVlLFxuICAgICAgY29yczogdHJ1ZSxcbiAgICAgIG9yaWdpbjogXCJodHRwOi8vbG9jYWxob3N0OjUxNzNcIixcbiAgICB9LFxuICAgIGJ1aWxkOiB7XG4gICAgICByb2xsdXBPcHRpb25zOiB7XG4gICAgICAgIGlucHV0OiB7XG4gICAgICAgICAgc2lkZWJhcjogXCJzcmMvc2lkZWJhci9pbmRleC5odG1sXCIsXG4gICAgICAgICAgb2Zmc2NyZWVuOiBcInNyYy9vZmZzY3JlZW4vb2Zmc2NyZWVuLmh0bWxcIixcbiAgICAgICAgICBcInNyYy9jb250ZW50L2NsYXVkZVwiOiBcInNyYy9jb250ZW50L2NsYXVkZS50c1wiLFxuICAgICAgICAgIFwic3JjL2NvbnRlbnQvY2hhdGdwdFwiOiBcInNyYy9jb250ZW50L2NoYXRncHQudHNcIixcbiAgICAgICAgICBcInNyYy9jb250ZW50L2dlbWluaVwiOiBcInNyYy9jb250ZW50L2dlbWluaS50c1wiLFxuICAgICAgICAgIFwic3JjL2NvbnRlbnQvZ3Jva1wiOiBcInNyYy9jb250ZW50L2dyb2sudHNcIixcbiAgICAgICAgICBcInNyYy9jb250ZW50L3BlcnBsZXhpdHlcIjogXCJzcmMvY29udGVudC9wZXJwbGV4aXR5LnRzXCIsXG4gICAgICAgICAgXCJzcmMvY29udGVudC9kZWVwc2Vla1wiOiBcInNyYy9jb250ZW50L2RlZXBzZWVrLnRzXCIsXG4gICAgICAgICAgXCJzcmMvY29udGVudC9mZXRjaC1pbnRlcmNlcHRvclwiOiBcInNyYy9jb250ZW50L2ZldGNoLWludGVyY2VwdG9yLnRzXCIsXG4gICAgICAgICAgXCJzcmMvY29udGVudC9pbnRlcmNlcHRvci1icmlkZ2VcIjogXCJzcmMvY29udGVudC9pbnRlcmNlcHRvci1icmlkZ2UudHNcIixcbiAgICAgICAgICBcInNyYy9jb250ZW50L3NpZGViYXItdG9nZ2xlL3RvZ2dsZVwiOiBcInNyYy9jb250ZW50L3NpZGViYXItdG9nZ2xlL3RvZ2dsZS50c1wiLFxuICAgICAgICB9LFxuICAgICAgICBvdXRwdXQ6IHtcbiAgICAgICAgICAvLyBAeGVub3ZhL3RyYW5zZm9ybWVycyBpcyBidW5kbGVkIGludG8gdGhlIG9mZnNjcmVlbiBjaHVuayB2aWFcbiAgICAgICAgICAvLyB0cmFuc2Zvcm1lcnMtbG9hZGVyLnRzIHN0YXRpYyBpbXBvcnQuIE5vIG1hbnVhbCBjaHVuayBzcGxpdCBuZWVkZWQuXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgdGFyZ2V0OiBcImVzbmV4dFwiLFxuICAgICAgLy8gRGlzYWJsZSBtaW5pZmljYXRpb24gLSB0ZXJzZXIgZmFpbHMgb24gUGhvZW5peCBsaWJyYXJ5IGNvZGVcbiAgICAgIG1pbmlmeTogZmFsc2UsXG4gICAgICAvLyBOZXZlciBlbWl0IHNvdXJjZSBtYXBzIGluIHByb2R1Y3Rpb25cbiAgICAgIHNvdXJjZW1hcDogZmFsc2UsXG4gICAgfSxcbiAgICByZXNvbHZlOiB7XG4gICAgICBhbGlhczogeyBcbiAgICAgICAgXCJAXCI6IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwic3JjXCIpLFxuICAgICAgfSxcbiAgICB9LFxuICB9O1xufSk7XG4iLCAie1xuICAgIFwibWFuaWZlc3RfdmVyc2lvblwiOiAzLFxuICAgIFwibmFtZVwiOiBcIkNvbnRleHQgTW92ZXJcIixcbiAgICBcInZlcnNpb25cIjogXCIxLjAuMlwiLFxuICAgIFwiZGVzY3JpcHRpb25cIjogXCJOZXZlciBsb3NlIGNvZGluZyBjb250ZXh0IGFnYWluLiBPbmUgbGF5ZXIuIEFueSBhZ2VudC4gWmVybyBmcmljdGlvbi5cIixcbiAgICBcImtleVwiOiBcIk1JSUJJakFOQmdrcWhraUc5dzBCQVFFRkFBT0NBUThBTUlJQkNnS0NBUUVBeUFwUEdqZVgxNG1OekhsakNFL3l6Vk44T1lHditNVkxNQm92UkFybEd1N1kraS9OOHIzOXM1bzFrZms0cFI0LzUrU1lXSFJuTyszZ0RzdDZmaGlXZC91U25VWGhiSWlTUjR4czIzS0huSyt6bWk2RlAyVFFBaUlwSWxpRTdKMi9qSkFIdXNBWDliRWNyK3FzR0hJd1VFa3NhV082bTdBaE5ER3NBa2pZMzdEdjBmZ1k0T2VsS0M1YkcrZFJrM0pQeVl6dlV1NFlHNmVlUUhzT2QralRpbkhjSWY3S1hFYXh6ditYL3lQVmpKZzc3eEhaRkthYW1rWHdMRUJydjgrNXByR2N2bXRyUGxYaDF1VHExRXhUcmtwTWJ2TzdjRGJkOTR2NTVDY3VUcGEvR1RmM2xVUndpVjJJYmFtZjI2VnlhY1ZuMUFtR25YUys4VkFXQmR6bmVRSURBUUFCXCIsXG4gICAgXCJwZXJtaXNzaW9uc1wiOiBbXG4gICAgICAgIFwiYWN0aXZlVGFiXCIsXG4gICAgICAgIFwic2NyaXB0aW5nXCIsXG4gICAgICAgIFwic3RvcmFnZVwiLFxuICAgICAgICBcInVubGltaXRlZFN0b3JhZ2VcIixcbiAgICAgICAgXCJ0YWJzXCIsXG4gICAgICAgIFwic2lkZVBhbmVsXCIsXG4gICAgICAgIFwiZG93bmxvYWRzXCIsXG4gICAgICAgIFwib2Zmc2NyZWVuXCIsXG4gICAgICAgIFwiaWRlbnRpdHlcIixcbiAgICAgICAgXCJhbGFybXNcIlxuICAgIF0sXG4gICAgXCJvYXV0aDJcIjoge1xuICAgICAgICBcImNsaWVudF9pZFwiOiBcIjUzNzMxNjA3ODUzNy1oY3BxZHExanNoM2VoNzQ4MDcxdTBxNGlkN2oxaWl2ZC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbVwiLFxuICAgICAgICBcInNjb3Blc1wiOiBbXG4gICAgICAgICAgICBcImh0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL2F1dGgvZHJpdmUuYXBwZGF0YVwiLFxuICAgICAgICAgICAgXCJodHRwczovL3d3dy5nb29nbGVhcGlzLmNvbS9hdXRoL3VzZXJpbmZvLmVtYWlsXCJcbiAgICAgICAgXVxuICAgIH0sXG4gICAgXCJob3N0X3Blcm1pc3Npb25zXCI6IFtcbiAgICAgICAgXCJodHRwczovL2NsYXVkZS5haS8qXCIsXG4gICAgICAgIFwiaHR0cHM6Ly9jaGF0Z3B0LmNvbS8qXCIsXG4gICAgICAgIFwiaHR0cHM6Ly9jaGF0Lm9wZW5haS5jb20vKlwiLFxuICAgICAgICBcImh0dHBzOi8vZ2VtaW5pLmdvb2dsZS5jb20vKlwiLFxuICAgICAgICBcImh0dHBzOi8vZ3Jvay5jb20vKlwiLFxuICAgICAgICBcImh0dHBzOi8vZ3Jvay54LmFpLypcIixcbiAgICAgICAgXCJodHRwczovL3d3dy5wZXJwbGV4aXR5LmFpLypcIixcbiAgICAgICAgXCJodHRwczovL2NoYXQuZGVlcHNlZWsuY29tLypcIixcbiAgICAgICAgXCJodHRwczovL2NvbnRleHRtb3Zlci5jb20vKlwiLFxuICAgICAgICBcImh0dHBzOi8vKi5jb250ZXh0bW92ZXIuY29tLypcIixcbiAgICAgICAgXCJodHRwczovL2h1Z2dpbmdmYWNlLmNvLypcIixcbiAgICAgICAgXCJodHRwczovLyouaHVnZ2luZ2ZhY2UuY28vKlwiLFxuICAgICAgICBcImh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC8qXCIsXG4gICAgICAgIFwiaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vKlwiLFxuICAgICAgICBcImh0dHBzOi8vYWNjb3VudHMuZ29vZ2xlLmNvbS8qXCIsXG4gICAgICAgIFwiaHR0cHM6Ly8qLnN1cGFiYXNlLmNvLypcIlxuICAgIF0sXG4gICAgXCJiYWNrZ3JvdW5kXCI6IHtcbiAgICAgICAgXCJzZXJ2aWNlX3dvcmtlclwiOiBcInNyYy9iYWNrZ3JvdW5kL3NlcnZpY2Utd29ya2VyLnRzXCIsXG4gICAgICAgIFwidHlwZVwiOiBcIm1vZHVsZVwiXG4gICAgfSxcbiAgICBcImNvbnRlbnRfc2NyaXB0c1wiOiBbXG4gICAgICAgIHtcbiAgICAgICAgICAgIFwibWF0Y2hlc1wiOiBbXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2NsYXVkZS5haS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2NoYXRncHQuY29tLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2hhdC5vcGVuYWkuY29tLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vZ2VtaW5pLmdvb2dsZS5jb20vKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9ncm9rLmNvbS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2dyb2sueC5haS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL3d3dy5wZXJwbGV4aXR5LmFpLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2hhdC5kZWVwc2Vlay5jb20vKlwiXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgXCJqc1wiOiBbXG4gICAgICAgICAgICAgICAgXCJzcmMvY29udGVudC9mZXRjaC1pbnRlcmNlcHRvci50c1wiXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgXCJydW5fYXRcIjogXCJkb2N1bWVudF9zdGFydFwiLFxuICAgICAgICAgICAgXCJ3b3JsZFwiOiBcIk1BSU5cIlxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgICBcIm1hdGNoZXNcIjogW1xuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9jbGF1ZGUuYWkvKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9jaGF0Z3B0LmNvbS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2NoYXQub3BlbmFpLmNvbS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2dlbWluaS5nb29nbGUuY29tLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vZ3Jvay5jb20vKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9ncm9rLnguYWkvKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly93d3cucGVycGxleGl0eS5haS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2NoYXQuZGVlcHNlZWsuY29tLypcIlxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFwianNcIjogW1xuICAgICAgICAgICAgICAgIFwic3JjL2NvbnRlbnQvaW50ZXJjZXB0b3ItYnJpZGdlLnRzXCJcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBcInJ1bl9hdFwiOiBcImRvY3VtZW50X3N0YXJ0XCJcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgICAgXCJtYXRjaGVzXCI6IFtcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2xhdWRlLmFpLypcIlxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFwianNcIjogW1xuICAgICAgICAgICAgICAgIFwic3JjL2NvbnRlbnQvY2xhdWRlLnRzXCJcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBcInJ1bl9hdFwiOiBcImRvY3VtZW50X3N0YXJ0XCIsXG4gICAgICAgICAgICBcImFsbF9mcmFtZXNcIjogZmFsc2VcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgICAgXCJtYXRjaGVzXCI6IFtcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2hhdGdwdC5jb20vKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9jaGF0Lm9wZW5haS5jb20vKlwiXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgXCJqc1wiOiBbXG4gICAgICAgICAgICAgICAgXCJzcmMvY29udGVudC9jaGF0Z3B0LnRzXCJcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBcInJ1bl9hdFwiOiBcImRvY3VtZW50X3N0YXJ0XCJcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgICAgXCJtYXRjaGVzXCI6IFtcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vZ2VtaW5pLmdvb2dsZS5jb20vKlwiXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgXCJqc1wiOiBbXG4gICAgICAgICAgICAgICAgXCJzcmMvY29udGVudC9nZW1pbmkudHNcIlxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFwicnVuX2F0XCI6IFwiZG9jdW1lbnRfc3RhcnRcIlxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgICBcIm1hdGNoZXNcIjogW1xuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9ncm9rLmNvbS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2dyb2sueC5haS8qXCJcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBcImpzXCI6IFtcbiAgICAgICAgICAgICAgICBcInNyYy9jb250ZW50L2dyb2sudHNcIlxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFwicnVuX2F0XCI6IFwiZG9jdW1lbnRfaWRsZVwiXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICAgIFwibWF0Y2hlc1wiOiBbXG4gICAgICAgICAgICAgICAgXCJodHRwczovL3d3dy5wZXJwbGV4aXR5LmFpLypcIlxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFwianNcIjogW1xuICAgICAgICAgICAgICAgIFwic3JjL2NvbnRlbnQvcGVycGxleGl0eS50c1wiXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgXCJydW5fYXRcIjogXCJkb2N1bWVudF9pZGxlXCJcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgICAgXCJtYXRjaGVzXCI6IFtcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2hhdC5kZWVwc2Vlay5jb20vKlwiXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgXCJqc1wiOiBbXG4gICAgICAgICAgICAgICAgXCJzcmMvY29udGVudC9kZWVwc2Vlay50c1wiXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgXCJydW5fYXRcIjogXCJkb2N1bWVudF9pZGxlXCJcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgICAgXCJtYXRjaGVzXCI6IFtcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2xhdWRlLmFpLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2hhdGdwdC5jb20vKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9jaGF0Lm9wZW5haS5jb20vKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9nZW1pbmkuZ29vZ2xlLmNvbS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2dyb2suY29tLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vZ3Jvay54LmFpLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vd3d3LnBlcnBsZXhpdHkuYWkvKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9jaGF0LmRlZXBzZWVrLmNvbS8qXCJcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBcImpzXCI6IFtcbiAgICAgICAgICAgICAgICBcInNyYy9jb250ZW50L3NpZGViYXItdG9nZ2xlL3RvZ2dsZS50c1wiXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgXCJydW5fYXRcIjogXCJkb2N1bWVudF9pZGxlXCJcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgICAgXCJtYXRjaGVzXCI6IFtcImh0dHBzOi8vKi8qXCIsIFwiaHR0cDovLyovKlwiXSxcbiAgICAgICAgICAgIFwiZXhjbHVkZV9tYXRjaGVzXCI6IFtcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2xhdWRlLmFpLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2hhdGdwdC5jb20vKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9jaGF0Lm9wZW5haS5jb20vKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9nZW1pbmkuZ29vZ2xlLmNvbS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2dyb2suY29tLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vZ3Jvay54LmFpLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vd3d3LnBlcnBsZXhpdHkuYWkvKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9jaGF0LmRlZXBzZWVrLmNvbS8qXCJcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBcImpzXCI6IFtcbiAgICAgICAgICAgICAgICBcInNyYy9jb250ZW50L3NpZGViYXItdG9nZ2xlL3RvZ2dsZS50c1wiXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgXCJydW5fYXRcIjogXCJkb2N1bWVudF9pZGxlXCIsXG4gICAgICAgICAgICBcImFsbF9mcmFtZXNcIjogZmFsc2VcbiAgICAgICAgfVxuICAgIF0sXG4gICAgXCJhY3Rpb25cIjoge1xuICAgICAgICBcImRlZmF1bHRfdGl0bGVcIjogXCJDb250ZXh0TW92ZXJcIixcbiAgICAgICAgXCJkZWZhdWx0X2ljb25cIjoge1xuICAgICAgICAgICAgXCIxNlwiOiBcImljb25zL2ljb24xNi5wbmdcIixcbiAgICAgICAgICAgIFwiMzJcIjogXCJpY29ucy9pY29uMzIucG5nXCIsXG4gICAgICAgICAgICBcIjQ4XCI6IFwiaWNvbnMvaWNvbjQ4LnBuZ1wiLFxuICAgICAgICAgICAgXCIxMjhcIjogXCJpY29ucy9pY29uMTI4LnBuZ1wiXG4gICAgICAgIH1cbiAgICB9LFxuICAgIFwic2lkZV9wYW5lbFwiOiB7XG4gICAgICAgIFwiZGVmYXVsdF9wYXRoXCI6IFwic3JjL3NpZGViYXIvaW5kZXguaHRtbFwiXG4gICAgfSxcbiAgICBcIndlYl9hY2Nlc3NpYmxlX3Jlc291cmNlc1wiOiBbXG4gICAgICAgIHtcbiAgICAgICAgICAgIFwicmVzb3VyY2VzXCI6IFtcbiAgICAgICAgICAgICAgICBcInNyYy9jb250ZW50L2ZldGNoLWludGVyY2VwdG9yLnRzXCIsXG4gICAgICAgICAgICAgICAgXCJhc3NldHMvKi5qc1wiLFxuICAgICAgICAgICAgICAgIFwiYXNzZXRzLyouY3NzXCIsXG4gICAgICAgICAgICAgICAgXCJhc3NldHMvKi5wbmdcIixcbiAgICAgICAgICAgICAgICBcImFzc2V0cy8qLnN2Z1wiLFxuICAgICAgICAgICAgICAgIFwiYXNzZXRzLyoud29mZjJcIixcbiAgICAgICAgICAgICAgICBcIndhc20vKlwiXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgXCJtYXRjaGVzXCI6IFtcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2xhdWRlLmFpLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2hhdGdwdC5jb20vKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9jaGF0Lm9wZW5haS5jb20vKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9nZW1pbmkuZ29vZ2xlLmNvbS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2dyb2suY29tLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vZ3Jvay54LmFpLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vd3d3LnBlcnBsZXhpdHkuYWkvKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9jaGF0LmRlZXBzZWVrLmNvbS8qXCJcbiAgICAgICAgICAgIF1cbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgICAgXCJyZXNvdXJjZXNcIjogW1xuICAgICAgICAgICAgICAgIFwiZ3JhbW1hcnMvd2ViLXRyZWUtc2l0dGVyLndhc21cIlxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFwibWF0Y2hlc1wiOiBbXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2NsYXVkZS5haS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2NoYXRncHQuY29tLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2hhdC5vcGVuYWkuY29tLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vZ2VtaW5pLmdvb2dsZS5jb20vKlwiLFxuICAgICAgICAgICAgICAgIFwiaHR0cHM6Ly9ncm9rLmNvbS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL2dyb2sueC5haS8qXCIsXG4gICAgICAgICAgICAgICAgXCJodHRwczovL3d3dy5wZXJwbGV4aXR5LmFpLypcIixcbiAgICAgICAgICAgICAgICBcImh0dHBzOi8vY2hhdC5kZWVwc2Vlay5jb20vKlwiXG4gICAgICAgICAgICBdXG4gICAgICAgIH1cbiAgICBdLFxuICAgIFwiY29udGVudF9zZWN1cml0eV9wb2xpY3lcIjoge1xuICAgICAgICBcImV4dGVuc2lvbl9wYWdlc1wiOiBcInNjcmlwdC1zcmMgJ3NlbGYnICd3YXNtLXVuc2FmZS1ldmFsJzsgb2JqZWN0LXNyYyAnbm9uZSc7IGJhc2UtdXJpICdub25lJzsgY29ubmVjdC1zcmMgJ3NlbGYnIGh0dHBzOi8vKi5zdXBhYmFzZS5jbyB3c3M6Ly8qLnN1cGFiYXNlLmNvIGh0dHBzOi8vY29udGV4dG1vdmVyLmNvbSBodHRwczovLyouY29udGV4dG1vdmVyLmNvbSBodHRwczovL2h1Z2dpbmdmYWNlLmNvIGh0dHBzOi8vKi5odWdnaW5nZmFjZS5jbyBodHRwczovL2Nkbi1sZnMuaHVnZ2luZ2ZhY2UuY28gaHR0cHM6Ly9jZG4tbGZzLXVzLTEuaHVnZ2luZ2ZhY2UuY28gaHR0cHM6Ly8qLmhmLnNwYWNlIGh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldCBodHRwczovLyouanNkZWxpdnIubmV0IGh0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tIGh0dHBzOi8vKi54ZXRodWIuaGYuY287IGZvcm0tYWN0aW9uICdub25lJzsgZnJhbWUtc3JjICdub25lJ1wiXG4gICAgfSxcbiAgICBcImljb25zXCI6IHtcbiAgICAgICAgXCIxNlwiOiBcImljb25zL2ljb24xNi5wbmdcIixcbiAgICAgICAgXCIzMlwiOiBcImljb25zL2ljb24zMi5wbmdcIixcbiAgICAgICAgXCI0OFwiOiBcImljb25zL2ljb240OC5wbmdcIixcbiAgICAgICAgXCIxMjhcIjogXCJpY29ucy9pY29uMTI4LnBuZ1wiXG4gICAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQU9BLFNBQVMsb0JBQWlDO0FBQzFDLE9BQU8sV0FBVztBQUNsQixTQUFTLFdBQVc7OztBQ1RwQjtBQUFBLEVBQ0ksa0JBQW9CO0FBQUEsRUFDcEIsTUFBUTtBQUFBLEVBQ1IsU0FBVztBQUFBLEVBQ1gsYUFBZTtBQUFBLEVBQ2YsS0FBTztBQUFBLEVBQ1AsYUFBZTtBQUFBLElBQ1g7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNKO0FBQUEsRUFDQSxRQUFVO0FBQUEsSUFDTixXQUFhO0FBQUEsSUFDYixRQUFVO0FBQUEsTUFDTjtBQUFBLE1BQ0E7QUFBQSxJQUNKO0FBQUEsRUFDSjtBQUFBLEVBQ0Esa0JBQW9CO0FBQUEsSUFDaEI7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNKO0FBQUEsRUFDQSxZQUFjO0FBQUEsSUFDVixnQkFBa0I7QUFBQSxJQUNsQixNQUFRO0FBQUEsRUFDWjtBQUFBLEVBQ0EsaUJBQW1CO0FBQUEsSUFDZjtBQUFBLE1BQ0ksU0FBVztBQUFBLFFBQ1A7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDSjtBQUFBLE1BQ0EsSUFBTTtBQUFBLFFBQ0Y7QUFBQSxNQUNKO0FBQUEsTUFDQSxRQUFVO0FBQUEsTUFDVixPQUFTO0FBQUEsSUFDYjtBQUFBLElBQ0E7QUFBQSxNQUNJLFNBQVc7QUFBQSxRQUNQO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0o7QUFBQSxNQUNBLElBQU07QUFBQSxRQUNGO0FBQUEsTUFDSjtBQUFBLE1BQ0EsUUFBVTtBQUFBLElBQ2Q7QUFBQSxJQUNBO0FBQUEsTUFDSSxTQUFXO0FBQUEsUUFDUDtBQUFBLE1BQ0o7QUFBQSxNQUNBLElBQU07QUFBQSxRQUNGO0FBQUEsTUFDSjtBQUFBLE1BQ0EsUUFBVTtBQUFBLE1BQ1YsWUFBYztBQUFBLElBQ2xCO0FBQUEsSUFDQTtBQUFBLE1BQ0ksU0FBVztBQUFBLFFBQ1A7QUFBQSxRQUNBO0FBQUEsTUFDSjtBQUFBLE1BQ0EsSUFBTTtBQUFBLFFBQ0Y7QUFBQSxNQUNKO0FBQUEsTUFDQSxRQUFVO0FBQUEsSUFDZDtBQUFBLElBQ0E7QUFBQSxNQUNJLFNBQVc7QUFBQSxRQUNQO0FBQUEsTUFDSjtBQUFBLE1BQ0EsSUFBTTtBQUFBLFFBQ0Y7QUFBQSxNQUNKO0FBQUEsTUFDQSxRQUFVO0FBQUEsSUFDZDtBQUFBLElBQ0E7QUFBQSxNQUNJLFNBQVc7QUFBQSxRQUNQO0FBQUEsUUFDQTtBQUFBLE1BQ0o7QUFBQSxNQUNBLElBQU07QUFBQSxRQUNGO0FBQUEsTUFDSjtBQUFBLE1BQ0EsUUFBVTtBQUFBLElBQ2Q7QUFBQSxJQUNBO0FBQUEsTUFDSSxTQUFXO0FBQUEsUUFDUDtBQUFBLE1BQ0o7QUFBQSxNQUNBLElBQU07QUFBQSxRQUNGO0FBQUEsTUFDSjtBQUFBLE1BQ0EsUUFBVTtBQUFBLElBQ2Q7QUFBQSxJQUNBO0FBQUEsTUFDSSxTQUFXO0FBQUEsUUFDUDtBQUFBLE1BQ0o7QUFBQSxN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
