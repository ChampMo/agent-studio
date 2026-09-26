#!/usr/bin/env node
/**
 * Write the `latest.json` an installed copy asks for.
 *
 * The app checks one URL — a release asset on the public repo — and that file
 * has to name, per platform, a bundle and the signature of *that exact file*.
 * Assembling it by hand is how a signature comes to belong to the previous
 * build: everything still looks right, and every install refuses the update
 * with a message about a bad signature rather than about a stale paste.
 *
 * So this reads the version from `tauri.conf.json`, finds the bundles the
 * build just produced, and copies each one's `.sig` out of the file Tauri
 * wrote next to it. Nothing here is typed twice.
 *
 * **The bundles are copied into `dist/` under their release names**, and the
 * manifest points at those names. The url has to be predicted — the asset does
 * not exist until it is uploaded — so the only way it cannot be wrong is for
 * one line of code to decide both the name written into the manifest and the
 * name of the file that gets uploaded. Tauri writes
 * `Agent Studio_0.1.0_x64-setup.exe`; the release carries
 * `AgentStudio-0.1.0-Setup-x64.exe`; a rename done by hand at upload time is a
 * manifest pointing at a 404.
 *
 *   node scripts/release-manifest.mjs            -> stages, writes, prints
 *   node scripts/release-manifest.mjs --notes-file NOTES.md
 *
 * Usage, end to end:
 *
 *   npm run package
 *   npm run release:manifest -- --notes-file NOTES.md
 *   gh release create vX.Y.Z dist/* --notes-file NOTES.md
 *
 * `latest.json` goes on the release as an asset, which is what makes
 * `/releases/latest/download/latest.json` resolve to it.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = resolve(ROOT, "src-tauri/target/release/bundle");
const DIST = resolve(ROOT, "dist");
const OUT = resolve(DIST, "latest.json");

const config = JSON.parse(
  readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8"),
);
const version = config.version;
const repo = process.env.AGENT_STUDIO_REPO ?? "ChampMo/agent-studio";

function arg(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : process.argv[at + 1] ?? null;
}

/**
 * The platforms this build actually produced, by the key Tauri asks for.
 *
 * Only Windows is listed because only Windows is built here — Tauri cannot
 * cross-compile a macOS bundle, and a manifest naming a file that does not
 * exist would turn "no update for your platform" into "the update failed".
 * An absent key is the honest way to say nothing is offered.
 */
const TARGETS = [
  {
    key: "windows-x86_64",
    // What `tauri build` wrote, and what the release asset will be called.
    built: `${BUNDLE}/nsis/Agent Studio_${version}_x64-setup.exe`,
    asset: `AgentStudio-${version}-Setup-x64.exe`,
  },
];

/** Shipped beside the installer, but never an update source: the updater
 *  installs the NSIS bundle. Staged so one `gh release create dist/*` uploads
 *  everything, and left out of `platforms` so nothing points at it. */
const ALSO = [
  {
    built: `${BUNDLE}/msi/Agent Studio_${version}_x64_en-US.msi`,
    asset: `AgentStudio-${version}-x64.msi`,
  },
];

/**
 * Take the previous release's installers out of `dist/` before staging this
 * one's.
 *
 * Every asset name carries its version, so nothing here is ever overwritten -
 * each run added two files and removed none, and the documented publish step
 * is `gh release create vX.Y.Z dist/*`. That glob would have put the previous
 * release's installers on the new release page, where somebody clicking the
 * top link downloads a build one version behind the notes they just read.
 *
 * It had never actually happened, because the folder was being emptied by
 * hand - a load-bearing step written down in no script and in no document.
 *
 * Narrow on purpose: only files this script itself would have written, and
 * only for a version that is not the one being staged now. Anything else in
 * the folder is somebody's and is left alone. What goes is printed, because a
 * script that deletes silently is worse than one that does not delete.
 */
function pruneOldAssets(keep) {
  if (!existsSync(DIST)) return;
  const ours = /^AgentStudio-\d+\.\d+\.\d+.*\.(exe|msi)$/;
  for (const name of readdirSync(DIST)) {
    if (!ours.test(name) || keep.has(name)) continue;
    rmSync(resolve(DIST, name));
    console.log(`[manifest] removed stale ${name}`);
  }
}

pruneOldAssets(new Set([...TARGETS, ...ALSO].map((t) => t.asset)));

const platforms = {};
const missing = [];

for (const target of TARGETS) {
  const sig = `${target.built}.sig`;
  if (!existsSync(target.built) || !existsSync(sig)) {
    missing.push(target);
    continue;
  }
  mkdirSync(DIST, { recursive: true });
  copyFileSync(target.built, resolve(DIST, target.asset));
  platforms[target.key] = {
    // Read from disk every time. A signature pasted from a previous run
    // verifies against a file nobody is shipping any more.
    signature: readFileSync(sig, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/v${version}/${target.asset}`,
  };
}

if (missing.length > 0) {
  console.error("\n[manifest] no signed bundle for:");
  for (const target of missing) console.error(`    ${target.key}`);
  console.error(
    [
      "",
      "  A `.sig` beside the bundle is what `createUpdaterArtifacts` produces,",
      "  so this usually means the build ran without a signing key.",
      "",
      "    npm run package",
      "",
    ].join("\n"),
  );
}

if (Object.keys(platforms).length === 0) process.exit(1);

for (const extra of ALSO) {
  if (!existsSync(extra.built)) continue;
  mkdirSync(DIST, { recursive: true });
  copyFileSync(extra.built, resolve(DIST, extra.asset));
  console.log(`[manifest] staged ${extra.asset}`);
}

const notesFile = arg("--notes-file");
const manifest = {
  version,
  // Whatever the release says, carried through unchanged: the app shows it
  // verbatim rather than summarising somebody else's release notes.
  notes: notesFile ? readFileSync(resolve(ROOT, notesFile), "utf8").trim() : "",
  // RFC 3339, which is what the updater parses. `toISOString` is UTC and says
  // so, which is the one date format this project has been bitten by omitting.
  pub_date: new Date().toISOString(),
  platforms,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`[manifest] ${OUT}`);
console.log(`[manifest] version ${version}, platforms: ${Object.keys(platforms).join(", ")}`);
for (const [key, entry] of Object.entries(platforms)) {
  console.log(`[manifest]   ${key} -> ${entry.url}`);
}
