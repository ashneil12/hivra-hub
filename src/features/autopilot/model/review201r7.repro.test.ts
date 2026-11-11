// Review of PR #201 round 7 (head f6f99aefd): red-first repros. Each test asserts the safe answer and fails on this head.
// The lookups are Node ports of fs.rs locate_path (git under the app's environment) and canonical_place (std canonicalize,
// i.e. realpath(3), which resolves ".." after a link physically).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { approvalVerdict } from "./decide";
import { placeStaysInside, safeCommand, type Canonical, type Locate, type RealPlace } from "./safeApproval";

const APP_GIT_ENV = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" };

/** fs.rs locate_path(path, follow_last = true): a missing path is placed by its nearest existing parent (Path::parent, lexical). */
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

/** fs.rs canonical_place: Path::file_name / pop (None on a trailing ".."), then realpath(3) of the existing part. */
const realCanonical: Canonical = async (paths) =>
  paths.map((p) => {
    let existing = p;
    const missing: string[] = [];
    for (;;) {
      try {
        fs.lstatSync(existing);
        break;
      } catch {
        const name = path.basename(existing);
        if (name === ".." || existing === "/") return null;
        missing.unshift(name);
        existing = path.dirname(existing);
      }
    }
    try {
      return [fs.realpathSync.native(existing), ...missing].join("/");
    } catch {
      return null;
    }
  });

const write = (file: string) => ({ text: "", tool: { title: "Write", kind: "edit" }, approval: { call: { tool: "Write", paths: [file] } } }) as any;
const bash = (command: string) => ({ text: "", tool: { title: command, kind: "execute" }, approval: { call: { tool: "Bash", command } } }) as any;

/** The whole approval path the hook runs: the words, then the app's lookups. */
async function verdict(block: any, folder: string): Promise<string> {
  const words = approvalVerdict(block, folder, undefined, new Set());
  if (words.kind === "held") return `held: ${words.why}`;
  const why = await placeStaysInside(block.approval.call, folder, realLocate, realCanonical);
  return why ? `held: ${why}` : "allow";
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "r201r7-")));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("HIGH (f6f99aefd): a backslash is read as a folder separator on a Mac, where it is a letter of a name", () => {
  it("does not allow a Write whose climb leaves the chat's checkout (a\\b\\c/../.. climbs above the chat on POSIX)", async () => {
    const home = `${TMP}/home`;
    const chat = `${home}/Projects/app`;
    fs.mkdirSync(`${chat}/src`, { recursive: true });
    fs.mkdirSync(`${home}/Projects/other/src`, { recursive: true });
    execFileSync("git", ["init", "-q", chat]);
    // The words read as <chat>/other/src/index.ts once each backslash is a separator; the Write tool (path.resolve) and the
    // OS read "a\b\c" as one name, so the climb goes two folders above the chat: <home>/Projects/other/src/index.ts.
    const file = `${chat}/a\\b\\c/../../other/src/index.ts`;
    expect(path.resolve(file)).toBe(`${home}/Projects/other/src/index.ts`);
    expect(await verdict(write(file), chat)).toMatch(/^held/);
  });

  it("does not allow a Write into a sibling folder whose name starts with the chat's (outside git)", async () => {
    const chat = `${TMP}/plain/notes`;
    fs.mkdirSync(chat, { recursive: true });
    const file = `${TMP}/plain/notes\\evil/x.md`;
    expect(path.resolve(file).startsWith(`${chat}/`)).toBe(false);
    expect(await verdict(write(file), chat)).toMatch(/^held/);
  });
});

describe("MED-B residual: a file glued to a short option after another letter (file -bfnotes)", () => {
  it("places notes in -bfnotes, as it places it in -fnotes", async () => {
    const chat = `${TMP}/mb/app`;
    fs.mkdirSync(chat, { recursive: true });
    execFileSync("git", ["init", "-q", chat]);
    fs.mkdirSync(`${TMP}/mb/secret`, { recursive: true });
    fs.writeFileSync(`${TMP}/mb/secret/netrc`, "machine x login y password z\n");
    fs.symlinkSync(`${TMP}/mb/secret/netrc`, `${chat}/notes`);
    expect(await verdict(bash("file -fnotes"), chat)).toMatch(/^held/);
    expect(await verdict(bash("file -bfnotes"), chat)).toMatch(/^held/);
  });
});

describe("LOW residual: a home timer reads a file it names through an option's value", () => {
  it("holds file -fnotes.txt at home, as it holds cat notes.txt", () => {
    expect(safeCommand("cat notes.txt", "/Users/example", true)).not.toBeNull();
    expect(safeCommand("file -fnotes.txt", "/Users/example", true)).not.toBeNull();
  });
  it("holds wc --files0-from=notes.txt at home", () => {
    expect(safeCommand("wc --files0-from=notes.txt", "/Users/example", true)).not.toBeNull();
  });
});

