#!/usr/bin/env node
/**
 * Dev launcher. In development this script plays the role Tauri plays in a
 * packaged build: it mints the per-launch session token and hands it to the
 * backend on stdin (PROJECT_BRIEF.md §9.1).
 *
 * The token never touches argv (world-readable in the process list) and never
 * touches an environment variable (inherited by children, captured in crash
 * dumps). The frontend reads it from the handshake file instead.
 *
 * This also replaces `uvicorn --reload`: the reloader re-executes the app in a
 * child process that cannot inherit the stdin we already consumed, so the token
 * would be lost on every reload. Restarting the whole process keeps one code
 * path for the handshake.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync, rmSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, ".data");
const HANDSHAKE = resolve(DATA_DIR, "dev-handshake.json");
const WATCH_DIR = resolve(ROOT, "services/agentd/agentd");

const freePort = () =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });

const token = randomBytes(32).toString("hex");
const port = await freePort();

mkdirSync(DATA_DIR, { recursive: true });
// Dev-only. Lives under the user's own profile, is gitignored, and is deleted
// on exit. A packaged build never writes this — Tauri injects the token
// straight into the webview.
writeFileSync(HANDSHAKE, JSON.stringify({ port, token }, null, 2), { mode: 0o600 });

let child = null;
let restarting = false;

function start() {
  child = spawn(
    "uv",
    ["run", "--project", "services/agentd", "python", "-m", "agentd"],
    {
      cwd: ROOT,
      stdio: ["pipe", "inherit", "inherit"],
      shell: process.platform === "win32",
      env: { ...process.env, AGENT_STUDIO_PORT: String(port) },
    }
  );
  child.stdin.write(token + "\n");
  child.stdin.end();
  child.on("exit", (code) => {
    if (restarting) return;
    if (code !== 0 && code !== null) console.error(`\n[dev] backend exited (${code})`);
    cleanup(code ?? 0);
  });
}

function restart() {
  if (!child || restarting) return;
  restarting = true;
  console.log("[dev] backend changed — restarting");
  child.once("exit", () => {
    restarting = false;
    start();
  });
  child.kill();
}

function cleanup(code = 0) {
  try {
    rmSync(HANDSHAKE, { force: true });
  } catch {}
  if (child && !child.killed) child.kill();
  process.exit(code);
}

let debounce = null;
watch(WATCH_DIR, { recursive: true }, (_e, file) => {
  if (!file || !file.endsWith(".py")) return;
  clearTimeout(debounce);
  debounce = setTimeout(restart, 150);
});

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

console.log(`[dev] handshake -> ${HANDSHAKE}`);
start();
