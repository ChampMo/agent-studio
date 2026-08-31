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
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { mkdirSync, writeFileSync, rmSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, ".data");
const HANDSHAKE = resolve(DATA_DIR, "dev-handshake.json");
const WATCH_DIR = resolve(ROOT, "services/agentd/agentd");
const WEB_PORT = 5173;
const IS_WIN = process.platform === "win32";

const freePort = () =>
  new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });

const portInUse = (port) =>
  new Promise((res) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      res(true);
    });
    sock.once("error", () => res(false));
  });

/**
 * Kill a child and everything it started.
 *
 * On Windows `spawn(..., { shell: true })` runs cmd.exe, which runs npm, which
 * runs the actual server. `child.kill()` reaches only cmd.exe: the grandchildren
 * survive, keep holding their ports, and the next `npm run dev` dies on "Port
 * 5173 is already in use". One run of this script left eight orphaned backends
 * behind before this existed.
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WIN) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    // Spawned detached below, so the negative pid addresses the whole group.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

if (await portInUse(WEB_PORT)) {
  console.error(
    `\n[dev] port ${WEB_PORT} is already in use.\n` +
      `      Usually a dev server from an earlier run that outlived its parent.\n` +
      (IS_WIN
        ? `      Free it with:  Get-NetTCPConnection -LocalPort ${WEB_PORT} -State Listen | ` +
          `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n`
        : `      Free it with:  lsof -ti tcp:${WEB_PORT} | xargs kill -9\n`),
  );
  process.exit(1);
}

const token = randomBytes(32).toString("hex");
const port = await freePort();

mkdirSync(DATA_DIR, { recursive: true });
// Dev-only. Lives under the user's own profile, is gitignored, and is deleted
// on exit. A packaged build never writes this — Tauri injects the token
// straight into the webview.
writeFileSync(HANDSHAKE, JSON.stringify({ port, token }, null, 2), { mode: 0o600 });

let child = null;
let vite = null;
let restarting = false;
let cleaningUp = false;

function start() {
  child = spawn(
    "uv",
    ["run", "--project", "services/agentd", "python", "-m", "agentd"],
    {
      cwd: ROOT,
      stdio: ["pipe", "inherit", "inherit"],
      shell: IS_WIN,
      detached: !IS_WIN,
      env: { ...process.env, AGENT_STUDIO_PORT: String(port) },
    },
  );
  // The token goes in on stdin and nowhere else: argv is world-readable in the
  // process list, and an env var would be inherited by every child.
  child.stdin.write(token + "\n");
  child.stdin.end();
  child.on("exit", (code) => {
    if (restarting || cleaningUp) return;
    if (code !== 0 && code !== null) console.error(`\n[dev] backend exited (${code})`);
    cleanup(code ?? 0);
  });
}

function startVite() {
  vite = spawn("npm", ["--workspace", "apps/desktop", "run", "dev"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: IS_WIN,
    detached: !IS_WIN,
  });
  vite.on("exit", (code) => {
    if (cleaningUp) return;
    if (code !== 0 && code !== null) console.error(`\n[dev] vite exited (${code})`);
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
  killTree(child);
}

function cleanup(code = 0) {
  if (cleaningUp) return;
  cleaningUp = true;
  try {
    // The handshake file is per-launch. Leaving it behind would hand the next
    // run's page a token that no longer authenticates anything.
    rmSync(HANDSHAKE, { force: true });
  } catch {}
  killTree(child);
  killTree(vite);
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
// A crash must not leak the children either: without this the orphans hold
// their ports and the next run cannot start.
process.on("uncaughtException", (err) => {
  console.error("[dev]", err);
  cleanup(1);
});

console.log(`[dev] handshake -> ${HANDSHAKE}`);
console.log(`[dev] backend  -> http://127.0.0.1:${port}`);
console.log(`[dev] frontend -> http://127.0.0.1:${WEB_PORT}`);
start();
startVite();
