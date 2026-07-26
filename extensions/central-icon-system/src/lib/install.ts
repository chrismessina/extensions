/**
 * The shell command that installs a style's icon data.
 *
 * Deliberately free of `@raycast/api` imports so it stays unit-testable — the
 * quoting rule below is easy to get wrong and impossible to notice until
 * someone clones into a path with a space in it.
 */

/**
 * Wrap a path in single quotes only when the shell would otherwise mangle it.
 *
 * Most install paths are boring (`~/.config/raycast/extensions/…`) and quoting
 * them unconditionally makes the copied command look defensive. But a clone
 * under `~/Dev Projects/…` produces a `cd` that silently targets the wrong
 * directory, so anything with whitespace or shell metacharacters gets quoted —
 * with embedded single quotes escaped the POSIX way (`'\''`).
 */
export function shellQuote(path: string): string {
  if (!/[\s'"\\$`!*?()[\]{};&|<>#~]/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * A copy-pasteable command that installs the given styles.
 *
 * Includes the `cd` rather than printing the directory separately: the path is
 * long enough to truncate an empty-state description, and the user's actual
 * need is to paste one line into a terminal, not to read a filesystem path.
 *
 * `root` must be a working copy of this repo. When the extension is running
 * from Raycast's install directory — which has no `scripts/` — pass `null` and
 * render {@link installCommandUnknownRoot} instead of a command that will fail.
 */
export function installCommand(styles: string[], root: string): string {
  return `cd ${shellQuote(root)} && npm run build:icons ${styles.join(" ")}`;
}

/**
 * The command to run once the user is in their own clone of this repo.
 *
 * Used when the extension can't locate a working copy: a `cd` into Raycast's
 * install directory would produce a command that fails, so the directory is
 * left for the user to supply.
 */
export function installCommandUnknownRoot(styles: string[]): string {
  return `npm run build:icons ${styles.join(" ")}`;
}
