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
        popup: "src/popup/index.html",
        sidebar: "src/sidebar/index.html",
        "src/content/claude": "src/content/claude.ts",
        "src/content/chatgpt": "src/content/chatgpt.ts",
        "src/content/gemini": "src/content/gemini.ts",
        "src/content/grok": "src/content/grok.ts",
      },
    },
    target: "esnext",
    minify: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
