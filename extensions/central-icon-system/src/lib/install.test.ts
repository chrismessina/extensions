import { describe, expect, it } from "vitest";
import { installCommand, installCommandUnknownRoot, shellQuote } from "./install";

describe("shellQuote", () => {
  it("leaves an ordinary path unquoted", () => {
    // Quoting unconditionally makes the copied command look defensive for the
    // common case, which is every default install location.
    expect(shellQuote("/Users/me/.config/raycast/extensions/central-icon-system")).toBe(
      "/Users/me/.config/raycast/extensions/central-icon-system",
    );
  });

  it("quotes a path containing spaces", () => {
    // Without this the `cd` silently targets the wrong directory.
    expect(shellQuote("/Users/me/Dev Projects/central-icon-system")).toBe(
      "'/Users/me/Dev Projects/central-icon-system'",
    );
  });

  it("escapes embedded single quotes the POSIX way", () => {
    expect(shellQuote("/Users/me/it's/here")).toBe(`'/Users/me/it'\\''s/here'`);
  });

  it("quotes shell metacharacters, not just whitespace", () => {
    for (const path of ["/tmp/a&b", "/tmp/a;b", "/tmp/a$b", "/tmp/a(b)"]) {
      expect(shellQuote(path).startsWith("'")).toBe(true);
    }
  });
});

describe("installCommand", () => {
  it("includes the cd so the command is pasteable as one line", () => {
    expect(installCommand(["round-outlined-radius-1-stroke-1.5"], "/tmp/ext")).toBe(
      "cd /tmp/ext && npm run build:icons round-outlined-radius-1-stroke-1.5",
    );
  });

  it("installs every missing style in one command", () => {
    expect(installCommand(["a", "b"], "/tmp/ext")).toBe("cd /tmp/ext && npm run build:icons a b");
  });

  it("quotes the directory when it needs it", () => {
    expect(installCommand(["a"], "/tmp/my ext")).toBe("cd '/tmp/my ext' && npm run build:icons a");
  });
});

describe("installCommandUnknownRoot", () => {
  it("omits the cd when no working copy was found", () => {
    // Raycast's install directory holds build output only — no `scripts/` — so
    // `cd`-ing there produces `Cannot find module .../build-manifest.mjs`.
    // Leaving the directory to the user is the only honest command.
    expect(installCommandUnknownRoot(["square-filled-radius-0-stroke-1.5"])).toBe(
      "npm run build:icons square-filled-radius-0-stroke-1.5",
    );
  });

  it("still installs every requested style", () => {
    expect(installCommandUnknownRoot(["a", "b"])).toBe("npm run build:icons a b");
  });
});
