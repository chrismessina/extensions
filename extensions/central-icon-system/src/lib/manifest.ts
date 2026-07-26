/**
 * Load icon metadata and read geometry on demand.
 *
 * **Why the split.** Raycast kills a command at 100 MB. A Node baseline is
 * ~42 MB and resvg's WASM adds ~16 MB, so the extension starts with barely
 * 40 MB to spend. Holding both styles' SVG strings resident costs ~26 MB and
 * pushed first paint to 101 MB — over the limit before a single tile existed.
 *
 * So metadata (names, categories, keywords: 0.26 MB per style) is resident, and
 * geometry lives in a flat `.svg` blob read by byte offset. A JSON map would
 * defeat this: parsing it to read one icon makes every icon resident. Random
 * access measured at ~1 ms for 400 icons, with flat memory.
 *
 * Manifests are built by `npm run build:icons` and are NOT committed — they hold
 * proprietary geometry. A missing manifest is an expected first-run state, not
 * a crash.
 */

import { environment } from "@raycast/api";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Corner, Fill, IconTile, Join, Radius, StyleAxes, StyleIndex, Stroke } from "../types";
import { CORNERS, FILLS, STROKES, styleId, tileId } from "../types";

/** Parsed indexes, keyed by style id. Read once per process, not per render. */
const indexCache = new Map<string, StyleIndex | null>();

/** Open file descriptors for geometry blobs, keyed by style id. */
const blobHandles = new Map<string, number | null>();

function indexPath(style: string): string {
  return join(environment.assetsPath, `central-icons.${style}.index.json`);
}

function blobPath(style: string): string {
  return join(environment.assetsPath, `central-icons.${style}.svg`);
}

/**
 * Read one style's metadata index. Returns `null` when it hasn't been built,
 * which is the normal state before `npm run build:icons` has run.
 */
export function loadIndex(style: string): StyleIndex | null {
  const hit = indexCache.get(style);
  // Only a successful read is memoized. Caching the miss would mean a style
  // built *while the command is open* stays invisible until relaunch — the
  // exact moment a user is most likely to look for it, having just run the
  // build command the download screen told them to run.
  if (hit) return hit;

  let index: StyleIndex | null = null;
  try {
    index = JSON.parse(readFileSync(indexPath(style), "utf8")) as StyleIndex;
  } catch {
    // ENOENT for an unbuilt style is expected; a malformed file is not, but the
    // recovery is identical (rebuild) so they share a path.
    index = null;
  }
  if (index) indexCache.set(style, index);
  return index;
}

function blobHandle(style: string): number | null {
  const hit = blobHandles.get(style);
  if (hit !== undefined) return hit;

  let fd: number | null = null;
  try {
    fd = existsSync(blobPath(style)) ? openSync(blobPath(style), "r") : null;
  } catch {
    fd = null;
  }
  blobHandles.set(style, fd);
  return fd;
}

/**
 * Bounded cache of rendered data URIs, keyed by tile id.
 *
 * **Why a cache and not a position window.** The previous design gave artwork
 * only to the first N tiles in display order. That failed the moment Raycast
 * filtered: searching "bug" surfaces matches at positions 696–2205, all of which
 * fell outside the window and rendered as placeholder circles. Raycast filters
 * internally and exposes no scroll event, so *which* tiles are on screen is
 * unknowable — but every tile it draws calls through here, so caching by id
 * bounds memory without needing to know.
 *
 * Insertion-ordered `Map` gives LRU eviction for free: re-reading a hit moves it
 * to the end, and the oldest entry is always `keys().next()`.
 *
 * **Cap sizing.** Measured against Raycast's 100 MB limit, in a fresh process
 * per run (reusing one process measures accumulated garbage, not the cap):
 *
 * | State | RSS |
 * |---|---|
 * | floor — WASM + both indexes + tile list | 74 MB |
 * | + 4,156 `Grid.Item`s with no content | 79 MB |
 * | + every tile's URI cached, backdrop on | 98 MB |
 *
 * That last row is a deliberate worst case — it forces all 4,156 tiles through
 * the cache in one pass, which real use never does. 500/700/900 all measured the
 * same 98 MB there, because the ~19 MB of URI strings is dominated by *how many
 * distinct tiles got drawn*, not by the cap. The cap's job is bounding a long
 * session, not the first paint.
 *
 * 600 is chosen over 900 for margin: it comfortably exceeds any realistic
 * viewport (a Small grid shows ~40 at once) while leaving room if a future style
 * ships heavier geometry.
 */
const URI_CACHE_LIMIT = 600;
const uriCache = new Map<string, string>();

/** Fetch a tile's data URI, rendering and caching it on first request. */
export function cachedDataUri(key: string, build: () => string | null): string | null {
  const hit = uriCache.get(key);
  if (hit !== undefined) {
    // Refresh recency: delete + re-set moves the key to the end of the Map.
    uriCache.delete(key);
    uriCache.set(key, hit);
    return hit;
  }

  const built = build();
  if (built === null) return null;

  uriCache.set(key, built);
  if (uriCache.size > URI_CACHE_LIMIT) {
    const oldest = uriCache.keys().next();
    if (!oldest.done) uriCache.delete(oldest.value);
  }
  return built;
}

/**
 * Forget every cached index and close open blob handles.
 *
 * Required after a rebuild: `loadIndex` memoizes successful reads, so without
 * this the post-update version read returns the pre-update value and the run
 * always reports "already up to date". Blob descriptors point at files the
 * rebuild replaced, so they're released too.
 */
export function invalidateManifests(): void {
  indexCache.clear();
  closeBlobs();
  uriCache.clear();
}

/** Drop every cached URI. Call when the rendering parameters change. */
export function clearUriCache(): void {
  uriCache.clear();
}

/**
 * Read one icon's SVG from its style's geometry blob.
 *
 * Returns `null` if the style isn't built or the icon isn't in its offset
 * table — callers render a placeholder rather than failing.
 */
export function readSvg(style: string, name: string): string | null {
  const index = loadIndex(style);
  const entry = index?.offsets?.[name];
  if (!entry) return null;

  const fd = blobHandle(style);
  if (fd === null) return null;

  const [offset, length] = entry;
  try {
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

/** Release blob file descriptors. Called when the command unmounts. */
export function closeBlobs(): void {
  for (const fd of blobHandles.values()) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed or never opened — nothing to recover.
      }
    }
  }
  blobHandles.clear();
}

/**
 * Build the tile list for the current axes and fill filter.
 *
 * Tiles carry metadata only — no `svg` field. Geometry is fetched per icon via
 * {@link readSvg} when a tile is actually rendered, copied, or exported.
 *
 * Fill is an axis of the *style id*, so showing both fills means reading two
 * indexes and interleaving them, so an icon's variants sit adjacent in the grid.
 *
 * `missing` lists any style whose index isn't built, so the caller can tell
 * "no icons" from "not built yet".
 */
export function loadTiles(axes: Omit<StyleAxes, "fill">, fills: Fill[]): { tiles: IconTile[]; missing: string[] } {
  const missing: string[] = [];
  const loaded: { fill: Fill; index: StyleIndex }[] = [];

  for (const fill of fills) {
    const style = styleId({ ...axes, fill });
    const index = loadIndex(style);
    if (!index) missing.push(style);
    else loaded.push({ fill, index });
  }

  if (loaded.length === 0) return { tiles: [], missing };

  // Index by name up front; a `.find()` per icon per style would be O(n²) over
  // 2,078 icons.
  const indexed = loaded.map((entry) => ({
    ...entry,
    byName: new Map(entry.index.icons.map((icon) => [icon.name, icon])),
  }));

  const tiles: IconTile[] = [];
  for (const { name } of loaded[0].index.icons) {
    for (const entry of indexed) {
      const source = entry.byName.get(name);
      if (!source) continue;
      tiles.push({
        ...source,
        id: tileId(source.name, entry.index.style),
        fill: entry.fill,
        style: entry.index.style,
      });
    }
  }

  return { tiles, missing };
}

/**
 * The project root — the only place `npm run build:icons` exists.
 *
 * `environment.assetsPath` is `<root>/assets` inside the installed extension,
 * so the parent is the directory the user cloned.
 */
export function projectRoot(): string | null {
  const candidate = join(environment.assetsPath, "..");
  // Raycast copies `package.json` into its install directory but ships only
  // build output — no `scripts/`, no `src/`. The `build:icons` script is
  // therefore *listed* there and fails with a bare
  // `Cannot find module .../scripts/build-manifest.mjs`. Probing for the script
  // itself is what distinguishes a working copy from an install dir; probing
  // for `package.json` would not.
  return existsSync(join(candidate, "scripts", "build-manifest.mjs")) ? candidate : null;
}

/**
 * The upstream version any installed style was built from.
 *
 * Every style in the scope publishes in lockstep, so the first installed one
 * answers for all of them. Returns `null` when nothing is installed.
 */
export function installedVersion(): string | null {
  for (const style of availableStyles()) {
    const index = loadIndex(style);
    if (index?.version) return index.version;
  }
  return null;
}

/** Categories present across the loaded indexes, sorted, for the dropdown. */
export function categoriesFor(tiles: IconTile[]): string[] {
  return [...new Set(tiles.map((t) => t.category).filter((c): c is string => Boolean(c)))].sort();
}

/**
 * Which styles have actually been built.
 *
 * The style submenus must offer only these. Offering all 30 axis combinations
 * when two are built lets the user persist a selection with no data behind it —
 * a dead end that survives relaunch, because the choice lives in `useCachedState`.
 */
export function availableStyles(): Set<string> {
  const styles = new Set<string>();
  try {
    for (const file of readdirSync(environment.assetsPath)) {
      const match = /^central-icons\.(.+)\.index\.json$/.exec(file);
      if (match) styles.add(match[1]);
    }
  } catch {
    // Assets unreadable — the caller surfaces the empty state.
  }
  return styles;
}

/**
 * Axes of the first built style, used to recover from a persisted selection
 * that has no data behind it. Returns `null` when nothing is built at all —
 * the caller shows the "not built" empty state instead.
 */
export function defaultBuiltAxes(): Omit<StyleAxes, "fill"> | null {
  for (const style of availableStyles()) {
    const parsed = /^(round|square)-(?:filled|outlined)-radius-([0-3])-stroke-(1|1\.5|2)$/.exec(style);
    if (parsed) {
      return {
        join: parsed[1] as Join,
        radius: Number(parsed[2]) as Radius,
        stroke: parsed[3] as Stroke,
      };
    }
  }
  return null;
}

/** One selectable axis value, and whether its data exists on disk. */
export interface AxisOption<T> {
  value: T;
  built: boolean;
}

/**
 * Every axis value, each flagged with whether it has been built.
 *
 * **Not a filter.** An earlier version listed only reachable values, which
 * traded one failure for a worse one: with two styles built (both
 * `radius-2-stroke-1.5`) every axis collapsed to a single option, so the style
 * controls looked broken and the other 28 styles were unreachable — you could
 * never build them, because you could never select them.
 *
 * So all values are always offered. Unbuilt ones are marked in the menu and
 * selecting one lands on the "not built" screen, which carries both a recovery
 * action and the exact build command. Discoverable, and never a dead end.
 */
export function axisOptions(current: Omit<StyleAxes, "fill">): {
  corners: AxisOption<Corner>[];
  strokes: AxisOption<Stroke>[];
} {
  const built = availableStyles();
  const exists = (axes: Omit<StyleAxes, "fill">) => FILLS.some((fill) => built.has(styleId({ ...axes, fill })));

  return {
    corners: CORNERS.map((corner) => ({ value: corner, built: exists({ ...current, ...corner }) })),
    strokes: STROKES.map((stroke) => ({ value: stroke, built: exists({ ...current, stroke }) })),
  };
}
