// Round 10 (rewritten in round 11): a file tool's path is absolute only. A search (Grep, Glob, LS) with a relative or missing
// path resolves it against the chat folder when the provider pins its folder (Claude's launch keeps the shell and the
// tools in the chat folder, so `folderPinned` is set by approvalCall, never from the tool input). Any other provider's
// relative or missing search path waits. A symlink out of the chat is held by the lookup, pinned or not.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { approvalCall } from "../../../integrations/harness/providers/claude/claudeProtocol";
import { approvalVerdict } from "./decide";
import { openedForm, openedSearchPath, placeStaysInside, type Canonical, type Locate, type RealPlace } from "./safeApproval";

const APP_GIT_ENV = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" };

/** fs.rs locate_path (follow_last), in Node: a link is followed, a missing place is placed by its parent. */
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
      let parent = path.dirname(p);
      while (!(fs.existsSync(parent) && fs.statSync(parent).isDirectory())) parent = path.dirname(parent);
      directory = fs.realpathSync.native(parent);
      actual = `${directory}/${p.slice(parent.length + 1)}`;
    }
    let top: string;
    try {
      top = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { env: APP_GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).toString().replace(/[\r\n]+$/, "");
    } catch (error) {
      if (String((error as { stderr?: Buffer }).stderr ?? "").includes("not a git repository")) return null;
      throw error;
    }
    const repo = fs.realpathSync.native(top);
    if (actual !== repo && !actual.startsWith(`${repo}/`)) throw new Error("outside its checkout");
    return { root: top, relative: actual === repo ? "" : actual.slice(repo.length + 1), linked: !!entry?.isSymbolicLink(), dotGit: fs.existsSync(path.join(top, ".git")) };
  });

/** fs.rs canonical_place: a missing part is placed by its existing parent; a climb is refused. */
const realCanonical: Canonical = async (paths) =>
  paths.map((p) => {
    if (p.split("/").includes("..")) return null;
    let existing = p;
    const missing: string[] = [];
    for (;;) {
      try {
        fs.lstatSync(existing);
        break;
      } catch {
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    try {
      return path.join(fs.realpathSync.native(existing), ...missing);
    } catch {
      return null;
    }
  });

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "r201r10-")));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const chat = `${TMP}/home/Projects/app`;
fs.mkdirSync(`${chat}/src`, { recursive: true });
fs.writeFileSync(`${chat}/src/a.ts`, "x\n");
fs.mkdirSync(`${TMP}/home/Projects/other`, { recursive: true });
fs.writeFileSync(`${TMP}/home/Projects/other/secret.ts`, "x\n");
fs.symlinkSync(`${TMP}/home/Projects/other`, `${chat}/out`);
execFileSync("git", ["init", "-q", chat]);

/** A Claude request (approvalCall: the provider pins the folder) or a bare call from another provider (not pinned). */
const claude = (tool: string, input: Record<string, unknown>) => ({ text: "", tool: { title: tool, kind: "search" }, approval: { call: approvalCall(tool, input) } }) as any;
const other = (tool: string, paths?: string[]) => ({ text: "", tool: { title: tool, kind: "search" }, approval: { call: { tool, ...(paths ? { paths } : {}) } } }) as any;

async function verdict(b: any): Promise<string> {
  const words = approvalVerdict(b, chat, undefined, new Set());
  if (words.kind === "held") return `held: ${words.why}`;
  const why = await placeStaysInside(b.approval.call, chat, realLocate, realCanonical);
  return why ? `held: ${why}` : "allow";
}

describe("round 10/11: a file tool takes an absolute path only", () => {
  // POSIX fixture. On Windows the temp folder is a drive path, so a forward slash is held before this can say "relative".
  // The Windows-shaped twin below runs on every OS (round 8 skipped the Mac reading the same way).
  it.skipIf(process.platform === "win32")("holds a relative Edit, Write, NotebookEdit and Read, even one inside the chat, pinned or not", async () => {
    expect(await verdict(claude("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }))).toMatch(/^held/);
    expect(await verdict(claude("Read", { file_path: "src/a.ts" }))).toMatch(/^held/);
    expect(openedForm("src/a.ts", chat)).toEqual({ why: expect.stringContaining("relative") });
  });
});

describe("round 11: a search with a relative or missing path resolves it against the chat folder, when the provider pins it", () => {
  // POSIX fixture. On Windows the temp folder is a drive path, so this path is not the one the Windows reading opens.
  it.skipIf(process.platform === "win32")("allows a Claude no-path Grep and Glob inside the chat", async () => {
    expect(await verdict(claude("Grep", { pattern: "token" }))).toBe("allow");
    expect(await verdict(claude("Grep", { pattern: "token", path: "src" }))).toBe("allow");
  });

  // POSIX fixture. On Windows the temp folder is a drive path, so `src/a.ts` is held for its forward slash, not resolved.
  it.skipIf(process.platform === "win32")("allows a Claude relative Grep path that resolves inside the chat", async () => {
    expect(await verdict(claude("Grep", { pattern: "token", path: "src/a.ts" }))).toBe("allow");
  });

  it("holds a relative Grep path that climbs out of the chat", async () => {
    expect(await verdict(claude("Grep", { pattern: "token", path: "../other" }))).toMatch(/^held/);
  });

  it("holds a relative Grep path through a link out of the chat, though its spelling is inside it", async () => {
    expect(await verdict(claude("Grep", { pattern: "secret", path: "out" }))).toMatch(/^held/);
  });

  it("holds a relative or missing search from a provider that doesn't pin its folder", async () => {
    expect(await verdict(other("Grep", ["src"]))).toMatch(/^held/);
    expect(await verdict(other("Grep"))).toMatch(/^held/);
  });

  // POSIX fixture. On Windows the temp folder is a drive path, so `${chat}/src` is held for its forward slash.
  it.skipIf(process.platform === "win32")("keeps an absolute search path as it was", async () => {
    expect(await verdict(other("Grep", [`${chat}/src`]))).toBe("allow");
    expect(openedSearchPath(`${chat}/src`, chat, false)).toEqual({ path: `${chat}/src` });
  });
});

describe("round 13: the same file and search rules on a Windows path", () => {
  // A chat folder that is itself an 8.3 name, as a Windows runner temp is. The short-name hold must not catch the folder.
  // Path shapes only: a fake lookup, so this runs on every OS. An absolute path outside the chat stays held (round 12).
  const win = "C:\\Users\\RUNNER~1\\Projects\\app";
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  const locate: Locate = async (paths) =>
    paths.map((p) => {
      const place = norm(p);
      const base = norm(win);
      if (place !== base && !place.startsWith(`${base}/`)) return null;
      const relative = place === base ? "" : place.slice(base.length + 1);
      return { root: win, relative, linked: false, dotGit: true };
    });

  async function judged(b: any): Promise<string> {
    const words = approvalVerdict(b, win, undefined, new Set());
    if (words.kind === "held") return `held: ${words.why}`;
    const why = await placeStaysInside(b.approval.call, win, locate, async (paths) => paths);
    return why ? `held: ${why}` : "allow";
  }

  it("holds a relative Edit and Read, and the reason says relative", async () => {
    expect(await judged(claude("Edit", { file_path: "src\\a.ts", old_string: "a", new_string: "b" }))).toMatch(/^held/);
    expect(await judged(claude("Read", { file_path: "src\\a.ts" }))).toMatch(/^held/);
    expect(openedForm("src\\a.ts", win)).toEqual({ why: expect.stringContaining("relative") });
  });

  it("allows a Claude no-path Grep and a relative Grep inside a chat folder that has a short name", async () => {
    expect(await judged(claude("Grep", { pattern: "token" }))).toBe("allow");
    expect(await judged(claude("Grep", { pattern: "token", path: "src" }))).toBe("allow");
    expect(await judged(claude("Grep", { pattern: "token", path: "src\\a.ts" }))).toBe("allow");
  });

  it("keeps an absolute search path inside the chat, and holds one outside it", async () => {
    expect(await judged(other("Grep", [`${win}\\src`]))).toBe("allow");
    expect(openedSearchPath(`${win}\\src`, win, false)).toEqual({ path: `${win}\\src` });
    expect(await judged(other("Grep", ["C:\\Users\\dev\\other"]))).toMatch(/^held/);
  });
});
