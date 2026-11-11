// Review of PR #201 round 6 (head c4a97c180): red-first repros. Each test asserts the safe answer and fails on this head.
// The HIGH runs real git in a temporary folder through a Node port of fs.rs git_locate_file, the lookup the hook uses.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { approvalVerdict } from "./decide";
import { placeStaysInside, safeCommand, type Locate, type RealPlace } from "./safeApproval";
import { credentialBlock } from "../../../integrations/harness/core/credentialGuard";

/** fs.rs locate_path(path, follow_last = true), in Node: links followed, the checkout from `git rev-parse --show-toplevel`. */
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
      actual = fs.realpathSync(p);
      directory = path.dirname(actual);
    } else {
      let parent = path.dirname(p);
      while (!(fs.existsSync(parent) && fs.statSync(parent).isDirectory())) parent = path.dirname(parent);
      directory = fs.realpathSync(parent);
      actual = `${directory}/${p.slice(parent.length + 1)}`;
    }
    let top: string;
    try {
      top = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "pipe"] })
        .toString()
        .replace(/[\r\n]+$/, "");
    } catch (error) {
      if (String((error as { stderr?: Buffer }).stderr ?? "").includes("not a git repository")) return null;
      throw error;
    }
    const repo = fs.realpathSync(top);
    if (actual !== repo && !actual.startsWith(`${repo}/`)) throw new Error("outside its checkout");
    return { root: top, relative: actual === repo ? "" : actual.slice(repo.length + 1), linked: !!entry?.isSymbolicLink() };
  });

const bash = (command: string) => ({ text: "", tool: { title: command, kind: "execute" }, approval: { call: { tool: "Bash", command } } }) as any;
const write = (file: string) => ({ text: "", tool: { title: "Write", kind: "edit" }, approval: { call: { tool: "Write", paths: [file] } } }) as any;

/** The whole approval path the hook runs: the words, then the app's lookup. */
async function verdict(block: any, folder: string): Promise<"allow" | "held"> {
  const words = approvalVerdict(block, folder, undefined, new Set());
  if (words.kind === "held") return "held";
  return (await placeStaysInside(block.approval.call, folder, realLocate)) ? "held" : "allow";
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r201r6-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("HIGH: a git folder planted by allowed writes makes an allowed git command run a program", () => {
  it("does not allow both the plant and git status in a chat whose folder is below its checkout's root", async () => {
    const repo = `${TMP}/mono`;
    const chat = `${repo}/packages/app`;
    fs.mkdirSync(`${chat}/src`, { recursive: true });
    fs.writeFileSync(`${chat}/src/app.ts`, "x\n");
    execFileSync("git", ["init", "-q", repo]);
    const plant: Record<string, string> = {
      "objects/readme": "x\n",
      "refs/readme": "x\n",
      config: `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = "echo ran > ${TMP}/ran.txt; false"\n`,
      HEAD: "ref: refs/heads/main\n",
    };
    const verdicts: string[] = [];
    for (const [name, text] of Object.entries(plant)) {
      verdicts.push(`${name}: ${await verdict(write(`${chat}/${name}`), chat)}`);
      // Each write autopilot allows lands, as the Write tool would make it.
      if (verdicts[verdicts.length - 1].endsWith("allow")) {
        fs.mkdirSync(path.dirname(`${chat}/${name}`), { recursive: true });
        fs.writeFileSync(`${chat}/${name}`, text);
      }
    }
    verdicts.push(`git status: ${await verdict(bash("git status"), chat)}`);
    verdicts.push(`git diff: ${await verdict(bash("git diff"), chat)}`);
    // The planted folder is now its own checkout to git: core.fsmonitor runs on `git status` (proved by hand on git 2.43).
    expect(verdicts.every((line) => line.endsWith("allow")), verdicts.join("\n")).toBe(false);
  });

  it("holds a write of a git directory's own files (HEAD, config) wherever it lands", () => {
    const folder = "/Users/example/Projects/mono/packages/app";
    for (const name of ["HEAD", "head", "sub/HEAD"]) {
      expect(approvalVerdict(write(`${folder}/${name}`), folder, undefined, new Set()).kind, name).toBe("held");
    }
  });
});

describe("MED: words that read outside the folder but look inside", () => {
  const FOLDER = "/Users/example/proj";
  const PROBE = ".monocode-autopilot-probe";
  const locateWith =
    (map: Record<string, RealPlace | null>): Locate =>
    async (paths) =>
      paths.map((p) => (p.endsWith(PROBE) ? { root: FOLDER, relative: PROBE } : p in map ? map[p] : { root: FOLDER, relative: p.slice(FOLDER.length + 1) }));

  it("holds zsh's =command word, which zsh turns into the program's absolute path (cat =git reads /usr/bin/git)", () => {
    expect(safeCommand("cat =git", FOLDER)).not.toBeNull();
    expect(safeCommand("head -c 4000 =node", FOLDER)).not.toBeNull();
  });

  it("places a file glued to a short option (file -fnotes prints every line of notes, a link to ~/.netrc)", async () => {
    const locate = locateWith({ [`${FOLDER}/notes`]: null });
    expect(await placeStaysInside({ tool: "Bash", command: "file -f notes" } as any, FOLDER, locate)).not.toBeNull();
    expect(await placeStaysInside({ tool: "Bash", command: "file -fnotes" } as any, FOLDER, locate)).not.toBeNull();
  });

  it("holds a read whose folder part is a link into another checkout, as it holds a link as the last part", async () => {
    const locate = locateWith({ [`${FOLDER}/vendor/app.ts`]: { root: "/Users/example/other", relative: "src/app.ts", linked: false } });
    expect(await placeStaysInside({ tool: "Bash", command: "cat vendor/app.ts" } as any, FOLDER, locate)).not.toBeNull();
    expect(await placeStaysInside({ tool: "Read", paths: [`${FOLDER}/vendor/app.ts`] } as any, FOLDER, locate)).not.toBeNull();
  });

  it("holds a Read of another checkout's file by its absolute path, as the same word in Bash waits", async () => {
    const locate = locateWith({ "/Users/example/other/config/prod.yml": { root: "/Users/example/other", relative: "config/prod.yml" } });
    expect(safeCommand("cat /Users/example/other/config/prod.yml", FOLDER)).not.toBeNull();
    const block = { text: "", tool: { title: "Read" }, approval: { call: { tool: "Read", paths: ["/Users/example/other/config/prod.yml"] } } } as any;
    const words = approvalVerdict(block, FOLDER, undefined, new Set());
    const place = await placeStaysInside(block.approval.call, FOLDER, locate);
    expect(words.kind === "held" || place !== null).toBe(true);
  });

  it("blocks the hub database read with the space escaped by a backslash (the guard that holds even with a yes)", () => {
    for (const command of [
      "cat ~/Library/Application\\ Support/com.ash.monocode-hub/monocode.db",
      "sqlite3 ~/Library/Application\\ Support/com.ash.monocode-hub/monocode.d\\b .dump",
    ]) {
      expect(credentialBlock({ tool: "Bash", command }, "/Users/ash/Projects/x"), command).toBeDefined();
    }
  });
});

describe("LOW: ag reads compressed files with -z, as rg -z does", () => {
  it("holds ag -z and --search-zip", () => {
    expect(safeCommand("ag -z token src", "/Users/example/proj")).not.toBeNull();
    expect(safeCommand("ag --search-zip token src", "/Users/example/proj")).not.toBeNull();
  });
});
