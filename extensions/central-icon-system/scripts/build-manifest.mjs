#!/usr/bin/env node
/**
 * Build a Central Icon System style manifest for the Raycast extension.
 *
 * Downloads a published `@central-icons-react/<style>` tarball, parses every
 * component into raw SVG (see `parse-central-icons.mjs`), joins it with the
 * package's own `icons-index.json` for categories and search aliases, and
 * writes one JSON asset per style.
 *
 * Usage:
 *   node scripts/build-manifest.mjs                      # both default styles
 *   node scripts/build-manifest.mjs <style> [<style>…]   # named styles
 *   node scripts/build-manifest.mjs --list               # all 30 style ids
 *
 * Output: assets/central-icons.<style>.json
 *
 * NOTE ON LICENSING: the output contains proprietary icon geometry and is
 * gitignored. It is built locally, for a licensed user, and is not
 * redistributed. See docs/research.md §1 before changing that.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseIconModule } from "./parse-central-icons.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "assets");
const SCOPE = "@central-icons-react";

/** The two styles bundled with the extension; the rest are on-demand packs. */
export const DEFAULT_STYLES = ["round-outlined-radius-2-stroke-1.5", "round-filled-radius-2-stroke-1.5"];

/** Every published style id. Square ships radius-0 only, hence 30 and not 36. */
export function allStyleIds() {
  const ids = [];
  for (const join of ["round", "square"]) {
    for (const fill of ["filled", "outlined"]) {
      for (const radius of join === "square" ? [0] : [0, 1, 2, 3]) {
        for (const stroke of ["1", "1.5", "2"]) {
          ids.push(`${join}-${fill}-radius-${radius}-stroke-${stroke}`);
        }
      }
    }
  }
  return ids;
}

/** Decompose a style id into its four axes, for the UI's submenus. */
export function parseStyleId(id) {
  const m = /^(round|square)-(filled|outlined)-radius-([0-3])-stroke-(1|1\.5|2)$/.exec(id);
  if (!m) throw new Error(`Unrecognized style id: ${id}`);
  return { join: m[1], fill: m[2], radius: Number(m[3]), stroke: m[4] };
}

/**
 * Upstream ships "Vehicles" (4 icons) and "Vehicles & Aircrafts" (35) as
 * separate categories — an unintended split, reported upstream. Merge them so
 * the dropdown doesn't show two near-identical entries.
 */
const CATEGORY_MERGES = new Map([["Vehicles", "Vehicles & Aircrafts"]]);

function log(...args) {
  console.log(...args);
}

/** Resolve the tarball URL and version for a style, via the public registry. */
async function resolvePackage(style) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(`${SCOPE}/${style}`)}`);
  if (!res.ok) throw new Error(`Registry lookup failed for ${style}: ${res.status} ${res.statusText}`);
  const meta = await res.json();
  const version = meta["dist-tags"]?.latest;
  if (!version) throw new Error(`No latest version for ${style}`);
  return { version, tarball: meta.versions[version].dist.tarball };
}

/**
 * Download and extract a style tarball into a temp dir, returning the package
 * root. Uses a direct tarball fetch rather than `npm install` deliberately: the
 * packages' `preinstall` hook requires CENTRAL_LICENSE_KEY and would otherwise
 * break this build for a licensed user who keeps their key elsewhere.
 */
async function fetchPackage(style, version, tarball, workDir) {
  const tgz = path.join(workDir, `${style}.tgz`);
  const res = await fetch(tarball);
  if (!res.ok) throw new Error(`Download failed for ${style}: ${res.status} ${res.statusText}`);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));

  const dest = path.join(workDir, style);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["xzf", tgz, "-C", dest]);
  fs.rmSync(tgz, { force: true });

  const pkg = path.join(dest, "package");
  if (!fs.existsSync(pkg)) throw new Error(`Unexpected tarball layout for ${style}`);
  return pkg;
}

/** Build one style's manifest object. Throws loudly on any inconsistency. */
export function buildManifest(pkgRoot, { style, version }) {
  const indexPath = path.join(pkgRoot, "icons-index.json");
  if (!fs.existsSync(indexPath)) throw new Error(`Missing icons-index.json in ${style}`);
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));

  // Invert categories → per-icon lookup, applying the upstream merge.
  const categoryOf = new Map();
  for (const [rawName, entry] of Object.entries(index.categories ?? {})) {
    const name = CATEGORY_MERGES.get(rawName) ?? rawName;
    for (const icon of entry.icons ?? []) categoryOf.set(icon, name);
  }

  const dirs = fs
    .readdirSync(pkgRoot)
    .filter((n) => n.startsWith("Icon") && fs.existsSync(path.join(pkgRoot, n, "index.mjs")))
    .sort();

  const icons = [];
  const uncategorized = [];
  for (const name of dirs) {
    const source = fs.readFileSync(path.join(pkgRoot, name, "index.mjs"), "utf8");
    const { svg, aliases } = parseIconModule(source, { name });

    // Prefer the index's alias string (richer, comma-separated) over the
    // component's ariaLabel; fall back when the index lacks an entry.
    const indexAliases = index.iconAliases?.[name];
    const keywords = indexAliases
      ? indexAliases.split(",").map((s) => s.trim()).filter(Boolean)
      : aliases;

    const category = categoryOf.get(name);
    if (!category) uncategorized.push(name);

    icons.push({ name, category: category ?? null, keywords, svg });
  }

  // Drift guards. The upstream publishes near-daily (357 versions in 15
  // months), so a silent shape change is the realistic failure mode.
  const expected = index.totalIcons;
  if (typeof expected === "number" && icons.length !== expected) {
    throw new Error(`${style}: parsed ${icons.length} icons but icons-index.json declares ${expected}`);
  }
  if (icons.length === 0) throw new Error(`${style}: no icons parsed`);

  const categories = [...new Set(icons.map((i) => i.category).filter(Boolean))].sort();

  // Metadata and geometry ship as SEPARATE files, and this split is what keeps
  // the extension alive.
  //
  // Raycast caps a command at 100 MB. Holding both styles' SVG strings resident
  // costs ~26 MB on top of a ~42 MB Node baseline and ~16 MB of resvg WASM —
  // which reached 101 MB before a single grid tile existed. The index alone is
  // 0.54 MB and resident cost drops to ~48 MB, leaving real headroom.
  //
  // The grid needs only names, categories and keywords to render and search.
  // Geometry is read per icon, on demand, when something is actually copied,
  // exported, or previewed.
  const iconIndex = {
    style,
    version,
    axes: parseStyleId(style),
    totalIcons: icons.length,
    categories,
    icons: icons.map(({ name, category, keywords }) => ({ name, category, keywords })),
  };

  // Geometry ships as a flat blob plus a byte-offset table, NOT as JSON.
  //
  // A JSON map has to be parsed whole to read one entry, so touching any icon
  // makes every icon resident — 20 MB for two styles, which is most of the
  // remaining budget. The blob supports random access: seek to (offset, length)
  // and read exactly one SVG. Measured at 1 ms for 400 icons, with flat memory.
  const chunks = [];
  const offsets = {};
  let position = 0;
  for (const { name, svg } of icons) {
    const buffer = Buffer.from(svg, "utf8");
    offsets[name] = [position, buffer.length];
    chunks.push(buffer);
    position += buffer.length;
  }

  return { index: iconIndex, blob: Buffer.concat(chunks), offsets, uncategorized };
}

async function buildStyle(style, workDir) {
  log(`\n▸ ${style}`);
  const { version, tarball } = await resolvePackage(style);
  log(`  version ${version}`);

  const pkgRoot = await fetchPackage(style, version, tarball, workDir);
  const { index, blob, offsets, uncategorized } = buildManifest(pkgRoot, { style, version });

  fs.mkdirSync(ASSETS, { recursive: true });

  // The offset table rides along with the index — it's small (~65 KB) and every
  // geometry read needs it, so there's no point deferring it.
  const indexOut = path.join(ASSETS, `central-icons.${style}.index.json`);
  const indexJson = JSON.stringify({ ...index, offsets });
  const blobOut = path.join(ASSETS, `central-icons.${style}.svg`);

  // Write to temporaries, then rename into place — geometry first, index last.
  //
  // The index is what makes a style *appear* installed and carries the byte
  // offsets every read depends on. Writing it before the blob means an
  // interrupted build (^C, disk full, dropped connection) leaves a style that
  // advertises itself as available while its offsets point into stale or
  // missing geometry, so icons render blank. Renaming last, and in this order,
  // means an interrupted build leaves the *previous* working data untouched:
  // rename is atomic within a filesystem, and the temporaries sit in the same
  // directory to guarantee that.
  const blobTmp = `${blobOut}.tmp`;
  const indexTmp = `${indexOut}.tmp`;
  try {
    fs.writeFileSync(blobTmp, blob);
    fs.writeFileSync(indexTmp, indexJson);
    fs.renameSync(blobTmp, blobOut);
    fs.renameSync(indexTmp, indexOut);
  } finally {
    // A failure before the renames must not leave partial files behind — they
    // would survive as junk and confuse the next run's disk-space estimate.
    for (const tmp of [blobTmp, indexTmp]) {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    }
  }

  log(`  ${index.totalIcons} icons, ${index.categories.length} categories`);
  log(`  → ${path.relative(ROOT, indexOut)} (${(indexJson.length / 1e6).toFixed(2)} MB, loaded at startup)`);
  log(`  → ${path.relative(ROOT, blobOut)} (${(blob.length / 1e6).toFixed(2)} MB, random access)`);
  if (uncategorized.length) {
    // Not fatal — but an invisible tail is exactly the SF Symbols bug (7.6% of
    // its symbols are reachable only under "All Categories"), so say so.
    log(`  ⚠ ${uncategorized.length} uncategorized: ${uncategorized.slice(0, 5).join(", ")}…`);
  }
  fs.rmSync(path.dirname(pkgRoot), { recursive: true, force: true });
  return index;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const id of allStyleIds()) log(id);
    return;
  }

  const styles = args.length ? args : DEFAULT_STYLES;
  const known = new Set(allStyleIds());
  for (const s of styles) {
    if (!known.has(s)) throw new Error(`Unknown style ${JSON.stringify(s)} — see --list`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "central-icons-"));
  try {
    for (const style of styles) await buildStyle(style, workDir);
    log(`\nDone. ${styles.length} style${styles.length === 1 ? "" : "s"} built.`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nBuild failed: ${error.message}`);
    process.exit(1);
  });
}
