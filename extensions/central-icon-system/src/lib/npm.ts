/**
 * Locating `npm` from inside Raycast.
 *
 * Raycast spawns commands with a minimal PATH — `/usr/bin:/bin:/usr/sbin:/sbin`
 * — not the PATH from a login shell. `execFile("npm", …)` therefore fails with
 * ENOENT on most machines, including ones where npm works fine in a terminal
 * (this one has it at `~/.local/bin/npm`, which no hardcoded list would guess).
 *
 * So: ask the user's own login shell where npm is, and fall back to a search of
 * the usual install locations. Returns `null` when npm genuinely can't be found,
 * which the UI reports rather than failing with a cryptic ENOENT.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Install locations worth checking when the shell lookup doesn't answer. */
function candidates(): string[] {
  const home = homedir();
  return [
    join(home, ".local/bin/npm"),
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
    join(home, ".volta/bin/npm"),
    join(home, ".bun/bin/npm"),
    "/usr/bin/npm",
  ];
}

let cached: string | null | undefined;

/**
 * Absolute path to `npm`, or `null` if it can't be found.
 *
 * Memoized: the shell spawn costs ~100 ms and the answer can't change while the
 * command is open.
 */
export function resolveNpmPath(): string | null {
  if (cached !== undefined) return cached;

  // A login shell sources the user's profile, so this finds npm wherever their
  // version manager put it — the only approach that works across nvm, fnm,
  // volta, asdf, Homebrew and hand-rolled setups alike.
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const found = execFileSync(shell, ["-lic", "command -v npm"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .pop();
    if (found && existsSync(found)) {
      cached = found;
      return cached;
    }
  } catch {
    // Non-interactive shells, unusual profiles, or a slow rc file — fall
    // through to the static search rather than giving up.
  }

  cached = candidates().find((path) => existsSync(path)) ?? null;
  return cached;
}
