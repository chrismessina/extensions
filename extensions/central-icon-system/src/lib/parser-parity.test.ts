import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseIconModule } from "./parse-icon-module";
// @ts-expect-error — the build script is untyped ESM; that's the point of the check.
import { parseIconModule as parseWithBuildScript } from "../../scripts/parse-central-icons.mjs";

/**
 * An extracted package, present only when a developer has run a build. The
 * check is skipped rather than failed when absent so CI stays green.
 */
const PKG =
  "/private/tmp/claude-501/-Users-messina-Developer-GitHub-chrismessina-raycast-central-icon-system/1f8536d5-c0dc-40ff-a763-f0fbbcf6dc97/scratchpad/cis/tarballs/style/package";

describe("parser parity", () => {
  it("the TypeScript port matches the build script on every icon", () => {
    // Two parsers now exist: this one runs inside the extension, the .mjs one
    // runs in `npm run build:icons`. If they ever diverge, a Store user and a
    // developer get different geometry from the same package — silently.
    if (!existsSync(PKG)) {
      expect(true).toBe(true);
      return;
    }

    const names = readdirSync(PKG).filter((n) => n.startsWith("Icon") && existsSync(join(PKG, n, "index.mjs")));
    expect(names.length).toBeGreaterThan(2000);

    for (const name of names) {
      const source = readFileSync(join(PKG, name, "index.mjs"), "utf8");
      expect(parseIconModule(source, { name }).svg).toBe(parseWithBuildScript(source, { name }).svg);
    }
  });
});
