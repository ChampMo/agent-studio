#!/usr/bin/env node
/**
 * `tauri build`, with the update signing key found and handed to it.
 *
 * `createUpdaterArtifacts` is on, so every bundle is signed and gets a `.sig`
 * beside it. Tauri reads the key from an environment variable and **fails the
 * build** when there is none — which is the right behaviour and a terrible
 * error to meet at the end of a five-minute compile, so this checks first and
 * says what to do.
 *
 * **The key is never in the repository**, and that is the whole reason this
 * script exists rather than a line in package.json. It lives outside the tree
 * (`~/.agent-studio/updater.key` by default) so there is no path by which
 * `git add -A` can publish the one secret that would let somebody else ship an
 * update to every install.
 *
 * Three places are looked at, in order:
 *
 *   TAURI_SIGNING_PRIVATE_KEY       the key itself, for CI, where a secret is
 *                                   an environment variable and never a file
 *   TAURI_SIGNING_PRIVATE_KEY_PATH  a path somebody set deliberately
 *   ~/.agent-studio/updater.key     what `tauri signer generate` was pointed
 *                                   at here
 *
 * The file is **read here and passed as the key itself**, because the bundler
 * only looks at `TAURI_SIGNING_PRIVATE_KEY`. Setting the `_PATH` variable — the
 * one `tauri signer generate` prints, and the obvious thing to reach for — got
 * `A public key has been found, but no private key`, and the build then
 * **exited 0 having produced unsigned bundles**. So this checks the `.sig`
 * files afterwards rather than trusting the exit code: a release that is
 * silently unsigned is one every install refuses, discovered by whoever
 * downloads it.
 *
 * Losing the private key is unrecoverable in the only sense that matters:
 * every installed copy verifies against the public half compiled into it, so a
 * new key means everyone has to install by hand once more. Back it up
 * somewhere that is not this machine.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_KEY = resolve(homedir(), ".agent-studio/updater.key");

const env = { ...process.env };

if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const path = env.TAURI_SIGNING_PRIVATE_KEY_PATH || DEFAULT_KEY;
  if (!existsSync(path)) {
    console.error(
      [
        "",
        "[build] No update signing key.",
        "",
        `  Looked at: ${path}`,
        "",
        "  Every bundle is signed so that an installed copy can verify an",
        "  update before it writes anything. Without the key there is nothing",
        "  to sign with, so the build would produce an update nobody can",
        "  install.",
        "",
        "  To make one:",
        "",
        `    npx tauri signer generate --ci -p "" -w "${DEFAULT_KEY}"`,
        "",
        "  Then put the printed public key in src-tauri/tauri.conf.json under",
        "  plugins.updater.pubkey. Changing the key means every existing",
        "  install has to be replaced by hand, so do this once and keep it.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  // The content, not the path. See the note above.
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(path, "utf8").trim();
  console.log(`[build] signing updates with ${path}`);
}

// An empty passphrase still has to be *stated*: the CLI prompts otherwise, and
// a prompt in a non-interactive build is a hang rather than an error.
if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
}

const result = spawnSync("npx", ["tauri", "build", ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
});
if (result.status !== 0) process.exit(result.status ?? 1);

// The CLI prints its signing failure and exits 0 anyway, so the exit code is
// not the thing to trust. What a signed build leaves behind is a `.sig` beside
// each bundle, and that is checkable.
const BUNDLES = resolve(ROOT, "src-tauri/target/release/bundle");
const unsigned = [];
for (const kind of ["nsis", "msi"]) {
  const dir = resolve(BUNDLES, kind);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".sig")) continue;
    if (!existsSync(resolve(dir, `${name}.sig`))) unsigned.push(`${kind}/${name}`);
  }
}
if (unsigned.length > 0) {
  console.error(
    [
      "",
      "[build] The bundles were produced but NOT signed:",
      ...unsigned.map((name) => `    ${name}`),
      "",
      "  An unsigned bundle is one every installed copy refuses, and the",
      "  Tauri CLI reports this by printing a line and exiting 0. Publishing",
      "  it would mean finding out from whoever downloads it.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
console.log("[build] every bundle has a signature beside it");
