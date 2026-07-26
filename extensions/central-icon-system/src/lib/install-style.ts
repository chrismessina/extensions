/**
 * Installing a style's icon data from inside the extension.
 *
 * **Why this exists.** The icon data is not in the published bundle — it is
 * proprietary and gitignored — so a Store install starts with an empty grid.
 * Originally the only remedy was `npm run build:icons`, which lives in
 * `scripts/` and therefore exists *only in a clone of the repo*. A Store user
 * has no clone, so the offered fix was unrunnable and the extension was
 * effectively broken on install.
 *
 * The build script needs nothing a Store install lacks: a registry fetch, `tar`
 * (present at `/usr/bin/tar` on macOS and shipped with Windows 10+), and a pure
 * parser. So the same pipeline runs here, writing into `environment.supportPath`
 * — a directory the extension owns and that survives updates, unlike `assets/`.
 *
 * `scripts/build-manifest.mjs` remains for development, and both write the same
 * format so either source works.
 */

import { environment } from "@raycast/api";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseIconModule } from "./parse-icon-module";

const execFileAsync = promisify(execFile);

const REGISTRY = "https://registry.npmjs.org";
const SCOPE = "@central-icons-react";

/**
 * Where installed icon data lives.
 *
 * `environment.supportPath`, not `assets/`: the bundle directory is replaced
 * wholesale on every extension update, which would silently delete every style
 * the user installed. Support path persists.
 */
export function dataDir(): string {
  return join(environment.supportPath, "icons");
}

/** Upstream ships `Vehicles` (4) and `Vehicles & Aircrafts` (35) separately. */
const CATEGORY_MERGES = new Map([["Vehicles", "Vehicles & Aircrafts"]]);

export interface InstallProgress {
  (message: string): void;
}

/**
 * Download, parse, and install one style.
 *
 * Mirrors `scripts/build-manifest.mjs`, including its atomic-write discipline:
 * temporaries are renamed into place with geometry first and the index last, so
 * an interrupted install leaves any previous working data intact rather than a
 * style that claims to be installed but reads blank.
 */
export async function installStyle(style: string, onProgress: InstallProgress = () => {}): Promise<string> {
  const work = join(tmpdir(), `central-icons-${style}-${process.pid}`);
  mkdirSync(work, { recursive: true });

  try {
    onProgress("Resolving package…");
    const response = await fetch(`${REGISTRY}/${encodeURIComponent(`${SCOPE}/${style}`)}`);
    if (!response.ok) throw new Error(`Registry lookup failed: ${response.status} ${response.statusText}`);
    const meta = (await response.json()) as {
      "dist-tags"?: { latest?: string };
      versions?: Record<string, { dist?: { tarball?: string } }>;
    };
    const version = meta["dist-tags"]?.latest;
    const tarball = version ? meta.versions?.[version]?.dist?.tarball : undefined;
    if (!version || !tarball) throw new Error(`No published version found for ${style}`);

    onProgress(`Downloading v${version}…`);
    const archive = await fetch(tarball);
    if (!archive.ok) throw new Error(`Download failed: ${archive.status} ${archive.statusText}`);
    const tgz = join(work, "package.tgz");
    writeFileSync(tgz, Buffer.from(await archive.arrayBuffer()));

    onProgress("Extracting…");
    // `tar` is at /usr/bin/tar on macOS and ships with Windows 10+; both read
    // gzip natively, so no JS tar dependency is needed.
    await execFileAsync("tar", ["xzf", tgz, "-C", work], { timeout: 120_000 });
    const pkgRoot = join(work, "package");
    if (!existsSync(pkgRoot)) throw new Error("Unexpected archive layout");

    onProgress("Parsing icons…");
    const built = buildFromPackage(pkgRoot, style, version);

    onProgress("Writing…");
    writeAtomically(style, built);

    return version;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

interface BuiltStyle {
  index: string;
  blob: Buffer;
  totalIcons: number;
}

/** Parse every component in an extracted package into our manifest format. */
function buildFromPackage(pkgRoot: string, style: string, version: string): BuiltStyle {
  const indexPath = join(pkgRoot, "icons-index.json");
  if (!existsSync(indexPath)) throw new Error("Package is missing icons-index.json");
  const upstream = JSON.parse(readFileSync(indexPath, "utf8")) as {
    categories?: Record<string, { icons?: string[] }>;
    iconAliases?: Record<string, string>;
    totalIcons?: number;
  };

  const categoryOf = new Map<string, string>();
  for (const [rawName, entry] of Object.entries(upstream.categories ?? {})) {
    const name = CATEGORY_MERGES.get(rawName) ?? rawName;
    for (const icon of entry.icons ?? []) categoryOf.set(icon, name);
  }

  const names = readdirSync(pkgRoot)
    .filter((n) => n.startsWith("Icon") && existsSync(join(pkgRoot, n, "index.mjs")))
    .sort();

  const icons: { name: string; category: string | null; keywords: string[] }[] = [];
  const chunks: Buffer[] = [];
  const offsets: Record<string, [number, number]> = {};
  let position = 0;

  for (const name of names) {
    const source = readFileSync(join(pkgRoot, name, "index.mjs"), "utf8");
    const { svg, aliases } = parseIconModule(source, { name });

    const indexAliases = upstream.iconAliases?.[name];
    const keywords = indexAliases
      ? indexAliases
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : aliases;

    icons.push({ name, category: categoryOf.get(name) ?? null, keywords });

    const buffer = Buffer.from(svg, "utf8");
    offsets[name] = [position, buffer.length];
    chunks.push(buffer);
    position += buffer.length;
  }

  // Drift guard: upstream publishes near-daily, so a shape change is the
  // realistic failure. Better to fail loudly than install a truncated set.
  if (typeof upstream.totalIcons === "number" && icons.length !== upstream.totalIcons) {
    throw new Error(`Parsed ${icons.length} icons but the package declares ${upstream.totalIcons}`);
  }
  if (icons.length === 0) throw new Error("No icons parsed");

  const parsed = /^(round|square)-(filled|outlined)-radius-([0-3])-stroke-(1|1\.5|2)$/.exec(style);
  if (!parsed) throw new Error(`Unrecognized style id: ${style}`);

  const categories = [...new Set(icons.map((i) => i.category).filter((c): c is string => Boolean(c)))].sort();

  return {
    index: JSON.stringify({
      style,
      version,
      axes: {
        join: parsed[1],
        fill: parsed[2],
        radius: Number(parsed[3]),
        stroke: parsed[4],
      },
      totalIcons: icons.length,
      categories,
      icons,
      offsets,
    }),
    blob: Buffer.concat(chunks),
    totalIcons: icons.length,
  };
}

/** Rename temporaries into place: geometry first, index last. */
function writeAtomically(style: string, built: BuiltStyle): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });

  const indexOut = join(dir, `central-icons.${style}.index.json`);
  const blobOut = join(dir, `central-icons.${style}.svg`);
  const indexTmp = `${indexOut}.tmp`;
  const blobTmp = `${blobOut}.tmp`;

  try {
    writeFileSync(blobTmp, built.blob);
    writeFileSync(indexTmp, built.index);
    renameSync(blobTmp, blobOut);
    renameSync(indexTmp, indexOut);
  } finally {
    for (const tmp of [blobTmp, indexTmp]) {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    }
  }
}

/** Remove an installed style's data. */
export function uninstallStyle(style: string): void {
  const dir = dataDir();
  for (const suffix of [".index.json", ".svg"]) {
    const target = join(dir, `central-icons.${style}${suffix}`);
    if (existsSync(target)) rmSync(target, { force: true });
  }
}
