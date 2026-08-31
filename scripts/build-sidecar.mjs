#!/usr/bin/env node
/**
 * Freeze the backend and put it where Tauri expects a sidecar
 * (PROJECT_BRIEF.md §12 M7).
 *
 * Tauri resolves `externalBin: ["binaries/agentd"]` by appending the *target
 * triple* of the build host — `binaries/agentd-x86_64-pc-windows-msvc.exe` here
 * — and refuses to bundle if that exact name is missing. The triple is asked of
 * rustc rather than assembled from `process.platform`, because the two disagree
 * on exactly the machines where it matters (an arm64 mac, a musl Linux).
 *
 * The frozen binary keeps the contract the dev launcher already uses: the port
 * arrives in `AGENT_STUDIO_PORT`, the session token on stdin, and the ready
 * line goes to stdout (§9.1). Nothing about the handshake changes when the
 * parent stops being `scripts/dev.mjs` and becomes the Tauri shell.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = resolve(ROOT, "services/agentd");
const OUT_DIR = resolve(ROOT, "src-tauri/binaries");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    console.error(`\n[sidecar] ${command} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}

/** The triple Tauri will look for. */
function targetTriple() {
  const out = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (out.status !== 0) {
    console.error("[sidecar] rustc not found — it is what names the binary.");
    process.exit(1);
  }
  const line = out.stdout.split("\n").find((l) => l.startsWith("host:"));
  if (!line) {
    console.error("[sidecar] rustc did not report a host triple.");
    process.exit(1);
  }
  return line.slice("host:".length).trim();
}

const triple = targetTriple();
const suffix = process.platform === "win32" ? ".exe" : "";
const built = resolve(SERVICE, `dist/agentd${suffix}`);
const target = resolve(OUT_DIR, `agentd-${triple}${suffix}`);

console.log(`[sidecar] building for ${triple}`);

// A stale build is worse than no build: it would be bundled and shipped, and
// the version mismatch only shows up as behaviour nobody can reproduce.
rmSync(resolve(SERVICE, "dist"), { recursive: true, force: true });
rmSync(resolve(SERVICE, "build"), { recursive: true, force: true });

run("uv", ["run", "--project", SERVICE, "pyinstaller", "--clean", "--noconfirm", "agentd.spec"], {
  cwd: SERVICE,
});

if (!existsSync(built)) {
  console.error(`[sidecar] PyInstaller reported success but ${built} is missing.`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
try {
  copyFileSync(built, target);
} catch (error) {
  if (error.code === "EBUSY" || error.code === "EPERM") {
    // Windows locks the image of a running process, so a backend left over
    // from a previous launch silently keeps the *old* binary in place. Without
    // this message the build looks like it succeeded and an installer ships
    // yesterday's backend.
    console.error(
      [
        "",
        `[sidecar] ${target}`,
        "          is locked, which means a copy of the backend is still running.",
        "          Close Agent Studio, or stop it: taskkill /IM agentd.exe /F",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  throw error;
}

const mb = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`[sidecar] ${target} (${mb} MB)`);
