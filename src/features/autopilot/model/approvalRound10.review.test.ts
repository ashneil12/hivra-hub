// Review of PR #201 round 9 (heads b9dbc174a, 2088c2618): red-first repros. The relative-path cases are red at b9dbc174a and
// green at 2088c2618; the NTFS stream and git -O cases are red at both.
// Claude Code opens a relative file path against its own current folder (p4: path.resolve(cwd, path)), and that folder
// moves: `cd sub` matches Claude Code's read-only list (/^cd(?:\s+...)?$/), so it runs with no approval request at all, and
// the Bash tool keeps the folder it ends in (pwd -P) while it stays inside the session's folders. The approval request
// (can_use_tool: tool_name, input, permission_suggestions, blocked_path, decision_reason, tool_use_id) carries no folder.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { approvalCall } from "../../../integrations/harness/providers/claude/claudeProtocol";
import { approvalVerdict } from "./decide";
import { editInside, placeStaysInside, safeCommand, type Canonical, type Locate, type RealPlace } from "./safeApproval";

const APP_GIT_ENV = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" };

/** fs.rs locate_path(path, follow_last = true): an existing path is canonicalized; a missing one is placed by its nearest existing parent. */
const realLocate: Locate = async (paths) =>
  paths.map((p): RealPlace | null => {
    let entry: fs.Stats | undefined;
    try {
      entry = fs.lstatSync(p);
    } catch {
      entry = undefined;
    }
    let directory: string;
    let actual: string;
    if (entry) {
      actual = fs.realpathSync.native(p);
      directory = path.dirname(actual);
    } else {
      if (p.includes("\\") && p.split("/").includes("..")) throw new Error("A backslash is part of a name here");
      let parent = path.dirname(p);
      while (!(fs.existsSync(parent) && fs.statSync(parent).isDirectory())) parent = path.dirname(parent);
      directory = fs.realpathSync.native(parent);
      actual = `${directory}/${p.slice(parent.length + 1)}`;
    }
    let top: string;
    try {
      top = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { env: APP_GIT_ENV, stdio: ["ignore", "pipe", "pipe"] })
        .toString()
        .replace(/[\r\n]+$/, "");
    } catch (error) {
      if (String((error as { stderr?: Buffer }).stderr ?? "").includes("not a git repository")) return null;
      throw error;
    }
    const repo = fs.realpathSync.native(top);
    if (actual !== repo && !actual.startsWith(`${repo}/`)) throw new Error("outside its checkout");
    return { root: top, relative: actual === repo ? "" : actual.slice(repo.length + 1), linked: !!entry?.isSymbolicLink(), dotGit: fs.existsSync(path.join(top, ".git")) };
  });

/** fs.rs canonical_place at round 9: a climb is refused, then realpath of the existing part. */
const round9Canonical: Canonical = async (paths) =>
  paths.map((p) => {
    if (!p.startsWith("/") || p.includes("\0") || p.split("/").includes("..")) return null;
    let existing = p;
    const missing: string[] = [];
    for (;;) {
      try {
        fs.lstatSync(existing);
        break;
      } catch {
        if (existing === "/") return null;
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    try {
      return [fs.realpathSync.native(existing), ...missing].join("/");
    } catch {
      return null;
    }
  });

/** Where Claude Code's file tools open a path (p4 in its cli.js): trimmed, then normalized or resolved against the folder. */
const claudeOpens = (file: string, cwd: string) => {
  const text = file.trim();
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(cwd, text);
};

const block = (tool: string, input: Record<string, unknown>) =>
  ({ text: "", tool: { title: tool, kind: tool === "Bash" ? "execute" : "edit" }, approval: { call: approvalCall(tool, input) } }) as any;

/** The whole approval path the hook runs: the words, then the app's lookups. */
async function verdict(b: any, folder: string): Promise<string> {
  const words = approvalVerdict(b, folder, undefined, new Set());
  if (words.kind === "held") return `held: ${words.why}`;
  const why = await placeStaysInside(b.approval.call, folder, realLocate, round9Canonical);
  return why ? `held: ${why}` : "allow";
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "r201r9-")));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("HIGH (b9dbc174a): a relative file path is checked against the chat's folder, but the tool opens it against its own", () => {
  const home = `${TMP}/rel/home`;
  const chat = `${home}/Projects/app`;
  const outside = `${home}/Library/LaunchAgents`;
  fs.mkdirSync(`${chat}/sub`, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(`${chat}/sub/keep`, "\n");
  // A link a repository can carry, in a subfolder: sub/out leads out of the chat.
  fs.symlinkSync("../../../Library/LaunchAgents", `${chat}/sub/out`);
  execFileSync("git", ["init", "-q", chat]);
  // After an unprompted `cd sub`, Claude Code's folder is <chat>/sub.
  const cwd = `${chat}/sub`;

  it.each(["Write", "Edit", "NotebookEdit"])("does not allow a relative %s that lands through a link from the tool's own folder", async (tool) => {
    const key = tool === "NotebookEdit" ? "notebook_path" : "file_path";
    const file = tool === "NotebookEdit" ? "out/x.ipynb" : "out/x.plist";
    expect(fs.realpathSync.native(path.dirname(claudeOpens(file, cwd)))).toBe(fs.realpathSync.native(outside));
    expect(await verdict(block(tool, { [key]: file, content: "x", old_string: "a", new_string: "b" }), chat)).toMatch(/^held/);
  });

  it("does not allow a relative Grep path that walks from the tool's own folder through a link", async () => {
    fs.writeFileSync(`${outside}/token.plist`, "secret\n");
    expect(fs.realpathSync.native(claudeOpens("out", cwd))).toBe(fs.realpathSync.native(outside));
    // Round 11: the repro's premise is Claude's folder moving to sub after a cd. The launch keeps the shell in the chat folder,
    // so a relative "out" is the chat's own out, which doesn't exist: a missing path inside the chat, allowed. The link the
    // repro names is <chat>/sub/out, which only a folder of sub reaches.
    expect(await verdict(block("Grep", { pattern: "secret", path: "out", output_mode: "content" }), chat)).toBe("allow");
  });
});

describe("MED (b9dbc174a, Windows): an NTFS stream suffix names the file itself, so a protected name hides behind it", () => {
  const chat = "C:\\Users\\dev\\Projects\\app";
  it.each(["opencode.json::$DATA", "CLAUDE.md::$DATA", "src\\HEAD::$DATA", "AGENTS.md:x"])("holds an edit of %s", (name) => {
    expect(editInside(`${chat}\\${name}`, chat)).not.toBeNull();
  });
});

describe("LOW (b9dbc174a): git's -O<orderfile> is a glued file name, not a flag cluster", () => {
  it("holds a home timer's git log -Onotes as it holds git log -O notes", () => {
    expect(safeCommand("git log -O notes", "/Users/example", true)).not.toBeNull();
    expect(safeCommand("git log -Onotes", "/Users/example", true)).not.toBeNull();
  });
});
