// Round 10: a file tool's path is checked as an absolute path only (Edit, Write, NotebookEdit, Read). A relative path is
// resolved by the tool against its own working folder, which a Bash `cd` can move, so it waits. A search (Grep, Glob, LS)
// with a relative or missing path resolves against the request's cwd, when the request names one; its cwd is checked in
// the chat (canonical, inside the folder). Without a cwd, such a search waits.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

const block = (tool: string, input: Record<string, unknown>) => ({
  text: "",
  tool: { title: tool, kind: tool === "Edit" || tool === "Write" ? "edit" : "read" },
  approval: { call: { tool, ...(input.paths ? { paths: input.paths } : {}), ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.command ? { command: input.command } : {}) } },
}) as any;

async function verdict(b: any): Promise<string> {
  const words = approvalVerdict(b, chat, undefined, new Set());
  if (words.kind === "held") return `held: ${words.why}`;
  const why = await placeStaysInside(b.approval.call, chat, realLocate, realCanonical);
  return why ? `held: ${why}` : "allow";
}

describe("round 10: a file tool takes an absolute path only", () => {
  it("holds a relative Edit, Write, NotebookEdit and Read, even one inside the chat", async () => {
    expect(await verdict(block("Edit", { paths: ["src/a.ts"] }))).toMatch(/^held/);
    expect(await verdict(block("Write", { paths: ["src/a.ts"] }))).toMatch(/^held/);
    expect(await verdict(block("NotebookEdit", { paths: ["src/n.ipynb"] }))).toMatch(/^held/);
    expect(await verdict(block("Read", { paths: ["src/a.ts"] }))).toMatch(/^held/);
  });

  it("allows an absolute Write and Read inside the chat", async () => {
    expect(await verdict(block("Write", { paths: [`${chat}/src/a.ts`] }))).toBe("allow");
    expect(await verdict(block("Read", { paths: [`${chat}/src/a.ts`] }))).toBe("allow");
  });

  it("names the relative path it holds, so the form is one check", () => {
    expect(openedForm("src/a.ts", chat)).toEqual({ why: expect.stringContaining("relative") });
    expect(openedForm(`${chat}/src/a.ts`, chat)).toEqual({ path: `${chat}/src/a.ts` });
  });
});

describe("round 10: a search resolves a relative or missing path against the request's cwd", () => {
  it("holds a relative or missing Grep path when the request names no cwd", async () => {
    expect(await verdict(block("Grep", { paths: ["src"] }))).toMatch(/^held/);
    expect(await verdict(block("Grep", {}))).toMatch(/^held/);
  });

  it("allows a relative Grep path that resolves inside the chat from a cwd inside it", async () => {
    expect(await verdict(block("Grep", { paths: ["a.ts"], cwd: `${chat}/src` }))).toBe("allow");
    expect(await verdict(block("Grep", { cwd: `${chat}/src` }))).toBe("allow");
  });

  it("holds a cwd outside the chat", async () => {
    expect(await verdict(block("Grep", { paths: ["x"], cwd: `${TMP}/home` }))).toMatch(/^held/);
  });

  it("holds a cwd that is a symlink out of the chat, though its own spelling is inside it (a cd through a link)", async () => {
    // `cd out` leaves the chat through the link `out`; the search then starts in ../other, outside the chat.
    expect(await verdict(block("Grep", { paths: ["secret.ts"], cwd: `${chat}/out` }))).toMatch(/^held/);
    expect(await verdict(block("Grep", { cwd: `${chat}/out` }))).toMatch(/^held/);
  });

  it("keeps an absolute search path as it was", async () => {
    expect(await verdict(block("Grep", { paths: [`${chat}/src`] }))).toBe("allow");
    expect(openedSearchPath(`${chat}/src`, chat, undefined)).toEqual({ path: `${chat}/src` });
  });
});
