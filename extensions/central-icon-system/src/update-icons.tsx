import { Action, ActionPanel, Clipboard, Detail, Icon, Keyboard, Toast, showToast } from "@raycast/api";
import { useCallback, useMemo, useRef, useState } from "react";
import { usePromise } from "@raycast/utils";
import { availableStyles, installedVersion, invalidateManifests, projectRoot } from "./lib/manifest";
import { fetchLatestVersion } from "./lib/updates";
import { resolveNpmPath } from "./lib/npm";
import { installCommand, installCommandUnknownRoot } from "./lib/install";
import { styleLabel } from "./types";

/** Run `npm run build:icons <styles>` in the project root. */
async function runBuild(npm: string, styles: string[], root: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(npm, ["run", "build:icons", ...styles], {
    cwd: root,
    // Rebuilding several styles means several ~5 MB downloads plus parsing
    // 2,078 components each; the default 10s would abort a legitimate run.
    timeout: 10 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * Update installed icon data to the latest upstream release.
 *
 * A **dedicated command** rather than a check on the search command's launch:
 * the grid is opened dozens of times a day and a network round-trip on every
 * one of those is the wrong trade for information that changes at most daily.
 * Checking is now something you ask for.
 */
export default function UpdateIcons() {
  // Null when running from Raycast's install directory (build output only, no
  // `scripts/`). Without a working copy the update can't be run in place.
  const root = projectRoot();
  const installed = useMemo(() => [...availableStyles()], []);
  const version = useMemo(() => installedVersion(), []);
  // Raycast's PATH doesn't include npm on most machines, so resolve it up front
  // — its absence changes what this screen can offer, not just what it does.
  const npm = useMemo(() => resolveNpmPath(), []);

  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // Synchronous re-entrancy guard: a double Enter fires `onAction` twice before
  // `updating` commits, launching two concurrent builds that write the same
  // asset files. A ref blocks the second call; state alone is too slow.
  const inFlight = useRef(false);

  const {
    data: latest,
    isLoading: checking,
    revalidate: recheck,
  } = usePromise(async () => (installed.length > 0 ? fetchLatestVersion(installed[0]) : null), []);

  const outdated = version !== null && latest !== null && latest !== undefined && latest !== version;

  const runUpdate = useCallback(async () => {
    if (inFlight.current || installed.length === 0 || !npm || !root) return;
    inFlight.current = true;
    setUpdating(true);
    const toast = await showToast({ style: Toast.Style.Animated, title: "Updating icon data…" });
    try {
      const before = installedVersion();
      await runBuild(npm, installed, root);
      // The rebuild rewrote the manifests on disk, but `loadIndex` memoizes
      // successful reads — without this the "after" read returns the pre-update
      // version and every run reports "already up to date".
      invalidateManifests();
      // Read from disk rather than trusting the command's output, so what's
      // reported is what actually landed.
      const after = installedVersion();

      const upgraded = before !== null && after !== null && before !== after;
      toast.style = Toast.Style.Success;
      if (upgraded) {
        toast.title = `Updated to v${after}`;
        toast.message = `from v${before}`;
        setResult(`# Icon Data Updated\n\nUpdated from \`v${before}\` to \`v${after}\`.`);
      } else {
        toast.title = "Already up to date";
        toast.message = after ? `v${after}` : undefined;
        setResult(
          `# Icon Data Up to Date\n\n${after ? `You're on the latest release (\`v${after}\`).` : "You're on the latest release."}`,
        );
      }
      // Refresh the upstream figure last: `usePromise`'s own toast lifecycle
      // would otherwise clobber the success toast set above.
      recheck();
    } catch (raw) {
      const error = raw as Error & { stdout?: string; stderr?: string };
      const message = (error.stderr || error.stdout || error.message || "Unknown error").trim().slice(0, 500);
      setResult(`# Update Failed\n\n\`\`\`\n${message}\n\`\`\``);
      toast.style = Toast.Style.Failure;
      toast.title = "Update failed";
      toast.message = message;
      toast.primaryAction = { title: "Copy Error", onAction: () => Clipboard.copy(message) };
    } finally {
      inFlight.current = false;
      setUpdating(false);
    }
  }, [npm, root, installed, recheck]);

  let markdown: string;
  if (installed.length === 0) {
    markdown = [
      "# No Icon Data Installed",
      "",
      "No styles have been installed yet. Open **Search Central Icon System** and pick a style to install it.",
    ].join("\n");
  } else if (updating) {
    markdown = ["# Updating Icon Data…", "", "Fetching the latest release and rebuilding installed styles."].join("\n");
  } else {
    // A completed run leads the body, so the outcome is unmissable on screen
    // and not just a toast that may have already faded.
    const lines = result
      ? [result, ""]
      : ["# Update Icon Data", "", "Rebuild installed styles against the latest `@central-icons-react` release.", ""];

    lines.push(version ? `**Installed:** \`v${version}\`` : "**Installed:** unknown");
    if (checking) lines.push("", "Checking for a newer release…");
    else if (latest)
      lines.push("", outdated ? `**Latest:** \`v${latest}\` — update available` : `**Latest:** \`v${latest}\``);
    else lines.push("", "_Could not reach the npm registry._");

    if (!root) {
      // The common case for anyone who installed rather than cloned.
      lines.push(
        "",
        "_This extension is running from Raycast's install directory, which contains build output only._",
        "_Copy the command below and run it from your clone of the repo._",
      );
    } else if (!npm) {
      lines.push(
        "",
        "_`npm` wasn't found on Raycast's PATH, so it can't run the update here._",
        "_Copy the command below and run it in a terminal instead._",
      );
    }

    lines.push("", "**Installed styles**", "");
    for (const style of installed) lines.push(`- ${styleLabel(style)}`);

    markdown = lines.join("\n");
  }

  return (
    <Detail
      isLoading={checking || updating}
      navigationTitle="Update Icon Data"
      markdown={markdown}
      actions={
        <ActionPanel>
          {installed.length > 0 && npm && root && (
            <Action title={updating ? "Updating…" : "Update Now"} icon={Icon.Download} onAction={runUpdate} />
          )}
          <Action
            title="Check Again"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={recheck}
          />
          {installed.length > 0 && (
            // Kept even when npm resolved: some people would rather watch the
            // build. When npm is missing this is the only way through.
            <Action.CopyToClipboard
              title="Copy Update Command"
              icon={Icon.Clipboard}
              content={root ? installCommand(installed, root) : installCommandUnknownRoot(installed)}
            />
          )}
          <Action.OpenInBrowser title="View Changelog" icon={Icon.Clock} url="https://centralicons.com/changelog" />
        </ActionPanel>
      }
    />
  );
}
