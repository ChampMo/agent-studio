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
 *
 * ## Why Vite runs in this process rather than as a child
 *
 * Windows cannot intercept a forced kill. When something kills this launcher —
 * a supervisor, a closed terminal, Stop-Process — no SIGTERM handler runs, so
 * no cleanup code executes, and any grandchild survives holding its port. That
 * is not a bug that can be fixed by better cleanup: the cleanup never gets to
 * run. Spawning `npm run dev` was three processes deep (cmd.exe -> npm -> vite)
 * and left an orphan on every hard kill, until the next start failed with
 * "Port 5173 is already in use" and blamed Vite for it.
 *
 * Running Vite through its Node API removes the layer entirely. The dev server
 * is this process, so it cannot outlive it. The backend stays a child because
 * it needs the token on stdin, but it listens on an ephemeral port, so an
 * orphaned one blocks nothing.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createSocket, createConnection } from "node:net";
import { mkdirSync, writeFileSync, rmSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer as createViteServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = resolve(ROOT, "apps/desktop");
const DATA_DIR = resolve(ROOT, ".data");
const HANDSHAKE = resolve(DATA_DIR, "dev-handshake.json");
const WATCH_DIR = resolve(ROOT, "services/agentd/agentd");
const WEB_PORT = 5173;
const IS_WIN = process.platform === "win32";

const freePort = () =>
  new Promise((res, rej) => {
    const srv = createSocket();
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
 * Reclaim the web port if — and only if — a leftover of ours is holding it.
 *
 * Older builds of this script could orphan a Vite; one may still be running
 * from before the in-process switch. The owner's command line is checked
 * against this repository first, so an unrelated program that happens to use
 * 5173 is reported rather than killed.
 */
function reclaimWebPort() {
  if (!IS_WIN) return false;
  const owners = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${WEB_PORT} -State Listen -ErrorAction SilentlyContinue |` +
        ` ForEach-Object { $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_.OwningProcess);` +
        ` "$($p.ProcessId)|$($p.CommandLine)" }`,
    ],
    { encoding: "utf8" },
  );

  let reclaimed = false;
  for (const line of (owners.stdout || "").split("\n")) {
    const [pid, ...rest] = line.trim().split("|");
    const cmd = rest.join("|");
    if (!pid || !cmd) continue;
    const ours = cmd.includes("agent-studio") || cmd.includes("vite.js");
    if (!ours) {
      console.error(`[dev] port ${WEB_PORT} is held by pid ${pid}, which is not ours:`);
      console.error(`      ${cmd.trim()}`);
      continue;
    }
    console.log(`[dev] reclaiming port ${WEB_PORT} from a leftover dev server (pid ${pid})`);
    spawnSync("taskkill", ["/pid", pid, "/T", "/F"], { stdio: "ignore" });
    reclaimed = true;
  }
  return reclaimed;
}

/** Kill a child and everything it started. */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WIN) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

if (await portInUse(WEB_PORT)) {
  reclaimWebPort();
  await new Promise((r) => setTimeout(r, 300));
  if (await portInUse(WEB_PORT)) {
    console.error(
      `\n[dev] port ${WEB_PORT} is still in use and is not ours to reclaim.\n` +
        (IS_WIN
          ? `      Free it with:  Get-NetTCPConnection -LocalPort ${WEB_PORT} -State Listen | ` +
            `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n`
          : `      Free it with:  lsof -ti tcp:${WEB_PORT} | xargs kill -9\n`),
    );
    process.exit(1);
  }
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
  // Vite lives in this process, so exiting takes it with us either way.
  vite?.close().catch(() => {});
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
process.on("uncaughtException", (err) => {
  console.error("[dev]", err);
  cleanup(1);
});

console.log(`[dev] handshake -> ${HANDSHAKE}`);
console.log(`[dev] backend  -> http://127.0.0.1:${port}`);

start();

vite = await createViteServer({
  root: WEB_ROOT,
  configFile: resolve(WEB_ROOT, "vite.config.ts"),
});
await vite.listen();
console.log(`[dev] frontend -> http://127.0.0.1:${WEB_PORT}`);
