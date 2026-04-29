import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
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
        "src/content/claude": "src/content/claude.ts",
        "src/content/chatgpt": "src/content/chatgpt.ts",
        "src/content/gemini": "src/content/gemini.ts",
        "src/content/grok": "src/content/grok.ts",
        "src/content/perplexity": "src/content/perplexity.ts",
        "src/content/deepseek": "src/content/deepseek.ts",
        "src/content/fetch-interceptor": "src/content/fetch-interceptor.ts",
        "src/content/interceptor-bridge": "src/content/interceptor-bridge.ts",
      },
    },
    target: "esnext",
    minify: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
