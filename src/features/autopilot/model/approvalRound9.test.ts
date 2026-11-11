// Review of PR #201 round 8 (head f09194d45): red-first repros. Each test asserts the safe answer and fails on this head.
// Claude Code's file tools (Write, Edit, Read, Grep) open `p4(file_path)`: the path trimmed (String.prototype.trim), then
// path.normalize for an absolute one or path.resolve(cwd, ...) for a relative one, so `..` is taken by words and the kernel
// then follows any link in what is left. A shell word (`cat x`) is opened by the kernel as written, `..` after a link
// included. The lookups below are Node ports of fs.rs locate_path (git under the app's environment) and of the round-8
// canonical_place (lexical_place, then realpath(3) of the existing part).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { approvalCall } from "../../../integrations/harness/providers/claude/claudeProtocol";
import { approvalVerdict } from "./decide";
import { placeStaysInside, type Canonical, type Locate, type RealPlace } from "./safeApproval";

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

/** fs.rs canonical_place at round 8: lexical_place (`..` taken by words, a climb past a backslash refused), then realpath of the existing part. */
const round8Canonical: Canonical = async (paths) =>
  paths.map((p) => {
    if (!p.startsWith("/") || p.includes("\0")) return null;
    const parts = p.split("/");
    if (p.includes("\\") && parts.includes("..")) return null;
    const out: string[] = [];
    for (const part of parts.slice(1)) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!out.length) return null;
        out.pop();
        continue;
      }
      out.push(part);
    }
    let existing = `/${out.join("/")}`;
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
  const why = await placeStaysInside(b.approval.call, folder, realLocate, round8Canonical);
  return why ? `held: ${why}` : "allow";
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "r201r8-")));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("HIGH-A (f09194d45): a path with leading whitespace is read as relative, but Claude Code trims it first", () => {
  const home = `${TMP}/ws/home`;
  const chat = `${home}/Projects/app`;
  fs.mkdirSync(`${chat}/src`, { recursive: true });
  fs.mkdirSync(`${home}/Projects/other/src`, { recursive: true });
  fs.writeFileSync(`${home}/Projects/other/package.json`, "{}\n");
  execFileSync("git", ["init", "-q", chat]);

  it.each([" ", "\t", " ", "\n"])("does not allow a Write to %j + an absolute path outside the chat", async (lead) => {
    const file = `${lead}${home}/Projects/other/package.json`;
    expect(claudeOpens(file, chat)).toBe(`${home}/Projects/other/package.json`);
    expect(await verdict(block("Write", { file_path: file, content: "x" }), chat)).toMatch(/^held/);
  });

  it("does not allow a Grep that walks the home folder (hidden files included) from a path with a leading space", async () => {
    fs.mkdirSync(`${home}/.kube`, { recursive: true });
    fs.writeFileSync(`${home}/.kube/config`, "token: x\n");
    expect(claudeOpens(` ${home}`, chat)).toBe(home);
    // The same walk without the space is held (round 5, H2).
    expect(await verdict(block("Grep", { pattern: "token", path: home, output_mode: "content" }), chat)).toMatch(/^held/);
    expect(await verdict(block("Grep", { pattern: "token", path: ` ${home}`, output_mode: "content" }), chat)).toMatch(/^held/);
  });
});

describe.skipIf(process.platform === "win32")("HIGH-B (f09194d45): in a git chat the lookup reads `..` after a link as the kernel does, the Write tool by words", () => {
  it("does not allow a Write whose words, once normalized as Claude Code opens them, go through a link out of the chat", async () => {
    const home = `${TMP}/lk/home`;
    const chat = `${home}/Projects/app`;
    fs.mkdirSync(`${chat}/deep/d`, { recursive: true });
    fs.mkdirSync(`${chat}/deep/S`, { recursive: true });
    fs.writeFileSync(`${chat}/deep/S/package.json`, "{}\n");
    fs.mkdirSync(`${home}/Projects/other`, { recursive: true });
    fs.writeFileSync(`${home}/Projects/other/package.json`, "{}\n");
    // Links a repository can carry: L to a folder inside it, S to its parent's sibling.
    fs.symlinkSync("deep/d", `${chat}/L`);
    fs.symlinkSync("../other", `${chat}/S`);
    execFileSync("git", ["init", "-q", chat]);
    const file = `${chat}/L/../S/package.json`;
    // Claude Code writes <chat>/S/package.json, which the kernel follows through S to the sibling project.
    expect(fs.realpathSync.native(claudeOpens(file, chat))).toBe(`${home}/Projects/other/package.json`);
    expect(await verdict(block("Write", { file_path: file, content: "x" }), chat)).toMatch(/^held/);
  });
});

describe.skipIf(process.platform === "win32")("MED (f09194d45, regression of round 8): outside git, a shell word's `..` after a link is taken by words", () => {
  it("does not allow cat link/../config when the kernel reads it through the link into a login store", async () => {
    const home = `${TMP}/og/home`;
    const chat = `${home}/Notes/research`;
    fs.mkdirSync(chat, { recursive: true });
    fs.mkdirSync(`${home}/.kube/cache`, { recursive: true });
    fs.writeFileSync(`${home}/.kube/config`, "users:\n- user:\n    token: secret\n");
    fs.symlinkSync(`${home}/.kube/cache`, `${chat}/cache`);
    // cat opens the word as written: the kernel follows `cache` and then climbs, so it reads ~/.kube/config.
    expect(fs.realpathSync.native(`${chat}/cache/../config`)).toBe(`${home}/.kube/config`);
    expect(await verdict(block("Bash", { command: "cat cache/../config" }), chat)).toMatch(/^held/);
  });
});

// Round 9, cases of the fix itself (the repros above are the red-first set).
import { editInside as editInsideRound9, openedForm } from "./safeApproval";
import { safeCommand as safeCommandRound9 } from "./safeApproval";

describe("round 9: flag-only clusters pass, and a shell word or a file path that isn't in tool form waits", () => {
  it("lets a home timer read flags only, and still holds a cluster that carries a file name", () => {
    expect(safeCommandRound9("ls -la", "/Users/example", true)).toBeNull();
    expect(safeCommandRound9("git log -n5", "/Users/example", true)).toBeNull();
    expect(safeCommandRound9("head -n5", "/Users/example", true)).toBeNull();
    expect(safeCommandRound9("file -bfnotes.txt", "/Users/example", true)).not.toBeNull();
  });

  it("holds a POSIX shell word with a literal backslash", () => {
    expect(safeCommandRound9("cat a\\\\b", "/Users/example/proj")).not.toBeNull();
  });

  it("holds a file path that isn't NFC or has a trailing separator, and allows the plain one", () => {
    expect(editInsideRound9("/Users/example/proj/src/café.ts", "/Users/example/proj")).not.toBeNull();
    expect(editInsideRound9("/Users/example/proj/src/", "/Users/example/proj")).not.toBeNull();
    expect(editInsideRound9("/Users/example/proj/src/a.ts", "/Users/example/proj")).toBeNull();
    expect(openedForm("src/a.ts", "/Users/example/proj")).toEqual({ path: "/Users/example/proj/src/a.ts" });
  });
});
