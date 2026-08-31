import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// import.meta.url, not __dirname: this package is ESM ("type": "module"), where
// __dirname does not exist at runtime.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const HANDSHAKE = resolve(ROOT, ".data/dev-handshake.json");

interface DevHandshake {
  port: number;
  token: string;
}

function readHandshake(): DevHandshake | null {
  try {
    return JSON.parse(readFileSync(HANDSHAKE, "utf8")) as DevHandshake;
  } catch {
    // Vite can boot before the backend has written the file. The app shows a
    // "waiting for the backend" state rather than failing to load.
    return null;
  }
}

/**
 * Hands the page its port and session token in development.
 *
 * The token is read from the handshake file that scripts/dev.mjs writes and
 * inlined into index.html at serve time. It deliberately does not travel as an
 * environment variable or a build-time define (PROJECT_BRIEF.md §9.1) — those
 * outlive the launch and end up in build output. Delivered this way it is
 * scoped to one page load, and a page on another origin cannot read it back:
 * the dev server sends no CORS headers, so a cross-origin fetch is blocked from
 * seeing the response.
 *
 * In a packaged build Tauri injects the same global and this plugin does not
 * run at all, so the frontend has exactly one code path for both.
 */
function devHandshake(): Plugin {
  return {
    name: "agent-studio-dev-handshake",
    apply: "serve",
    transformIndexHtml() {
      const config = readHandshake();
      if (!config) return [];
      return [
        {
          tag: "script",
          injectTo: "head" as const,
          children: `window.__AGENT_STUDIO__=${JSON.stringify({
            apiBase: `http://127.0.0.1:${config.port}`,
            wsBase: `ws://127.0.0.1:${config.port}`,
            token: config.token,
          })};`,
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwind(), devHandshake()],
  resolve: {
    alias: {
      "@": resolve(HERE, "src"),
      "@shared": resolve(ROOT, "packages/shared"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
