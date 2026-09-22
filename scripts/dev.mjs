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
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer as createViteServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = resolve(ROOT, "apps/desktop");
const DATA_DIR = resolve(ROOT, ".data");
const HANDSHAKE = resolve(DATA_DIR, "dev-handshake.json");
const WATCH_DIR = resolve(ROOT, "services/agentd/agentd");

/** Every .py under a directory, skipping the caches the watcher ignores. */
function* pythonSources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === ".pytest_cache") continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* pythonSources(path);
    else if (entry.name.endsWith(".py")) yield path;
  }
}
// Overridable, so a second copy of the app can be brought up beside the one
// already running instead of fighting it for the port.
//
// `PORT` is read too, because a harness that launches this script picks the
// port itself and has no way to know our own variable's name. Ours wins when
// both are set: one is a decision somebody made about this app, the other is
// whatever was free. Neither is a guess — 5173 is the last resort.
//
// It has to be honoured all the way down, not just here. Whatever this
// resolves to reaches Vite through `server.port` and reaches the backend as
// `AGENT_STUDIO_DEV_ORIGIN`, or the page loads on the new port and then fails
// every request against a CORS allowlist that never heard of it.
const WEB_PORT =
  Number(process.env.AGENT_STUDIO_WEB_PORT) || Number(process.env.PORT) || 5173;
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
    // This launcher, by name — not "a Vite". Every Vite dev server in the
    // world has `vite.js` on its command line, and this branch runs
    // `taskkill /F`, so matching on that made an unrelated project's server
    // ours to kill. Seen for real: another app was on 5173 and would have
    // been. The path is often relative (`node scripts/dev.mjs`), so the
    // repository root alone does not identify us either — both are checked.
    const ours =
      cmd.includes(ROOT) ||
      /scripts[\\/]dev\.mjs/.test(cmd) ||
      cmd.includes("agent-studio");
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
      env: {
        ...process.env,
        AGENT_STUDIO_PORT: String(port),
        // Only when the web server had to move. The backend's CORS allowlist
        // is explicit, so a page on another port would load and then fail
        // every request — reported as a CORS violation, which points at the
        // one thing that is not wrong.
        //
        // **Both spellings.** `127.0.0.1` and `localhost` are the same machine
        // and two different origins to a browser, which is why the shipped
        // entry for 5173 is a pair. This sent only the first, so a page opened
        // at `http://localhost:<other port>` — which is what a harness hands
        // you — was blocked on every request. We do not get to know which one
        // the browser will use, so we allow the two that mean this machine.
        ...(WEB_PORT === 5173
          ? {}
          : {
              AGENT_STUDIO_DEV_ORIGIN: [
                `http://127.0.0.1:${WEB_PORT}`,
                `http://localhost:${WEB_PORT}`,
              ].join(","),
            }),
      },
    },
  );
  // The token goes in on stdin and nowhere else: argv is world-readable in the
  // process list, and an env var would be inherited by every child.
  //
  // The pipe is then deliberately left open. The backend reads the end of its
  // stdin as "my parent is gone" and shuts down — the only signal that survives
  // a forced kill on Windows, where no handler in this process gets to run
  // (see `watch_parent` in agentd/__main__.py). Calling `end()` here closed it
  // a millisecond after the token went in, and the backend stopped itself
  // before the first request could arrive.
  child.stdin.write(token + "\n");
  child.on("exit", (code) => {
    if (restarting || cleaningUp) return;
    if (code !== 0 && code !== null) console.error(`\n[dev] backend exited (${code})`);
    cleanup(code ?? 0);
  });
}

function restart(because) {
  if (!child || restarting) return;
  restarting = true;
  console.log(`[dev] restarting backend — ${because ?? "requested"} changed`);
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
    // Only if it is still ours. Two launchers can overlap for a moment - the
    // harness starting a fresh one before the old one has finished dying -
    // and the old one's exit used to delete the handshake the new one had
    // just written. The page then sat on "Waiting for the backend" beside a
    // backend that was up and listening, with nothing to say why.
    try {
      if (JSON.parse(readFileSync(HANDSHAKE, "utf8")).token === token) {
        rmSync(HANDSHAKE, { force: true });
      }
    } catch {
      // Already gone, or not readable: nothing of ours to remove.
    }
  } catch {}
  killTree(child);
  // Vite lives in this process, so exiting takes it with us either way.
  vite?.close().catch(() => {});
  process.exit(code);
}

/**
 * What each watched file looked like last time we believed it.
 *
 * `fs.watch` on Windows is imprecise: writing `__pycache__/x.pyc` reliably
 * produces a notification naming `x.py` itself, and running the test suite
 * imports the whole package. So `npm test` restarted the backend — killing
 * whatever mission was in flight, three times before it was traced, each one
 * costing real tokens and reappearing as `crashed` with no cause on screen.
 *
 * Filtering by name cannot fix that, because the name it reports is a real
 * source file. Comparing the file's own size and mtime can: bytecode written
 * beside it changes neither.
 */
const seen = new Map();

function changed(path) {
  let stat = null;
  try {
    stat = statSync(path);
  } catch {
    // Deleted or mid-write. A restart is the safe reading of both.
    seen.delete(path);
    return true;
  }
  const mark = `${stat.mtimeMs}:${stat.size}`;
  if (seen.get(path) === mark) return false;
  seen.set(path, mark);
  return true;
}

// Prime it, so the first real edit is the first restart.
for (const file of pythonSources(WATCH_DIR)) changed(file);

let debounce = null;
watch(WATCH_DIR, { recursive: true }, (_e, file) => {
  if (!file || !file.endsWith(".py")) return;
  // Bytecode and test caches are written by simply *running* the code, and a
  // restart triggered by one kills whatever mission is in flight for no reason.
  if (file.includes("__pycache__") || file.includes(".pytest_cache")) return;
  if (!changed(resolve(WATCH_DIR, file))) return;
  clearTimeout(debounce);
  // Named, so a restart nobody asked for can be traced to the file that caused
  // it instead of looking like the backend falling over.
  debounce = setTimeout(() => restart(file), 150);
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
  // The override has to reach Vite, not just the log line. `strictPort` is on
  // in the config on purpose — the handshake hands the page a fixed origin —
  // so a port Vite silently moved off would be a page that cannot reach its
  // own backend.
  server: { port: WEB_PORT },
});
await vite.listen();
console.log(`[dev] frontend -> http://127.0.0.1:${WEB_PORT}`);
