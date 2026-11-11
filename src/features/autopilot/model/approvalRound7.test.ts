// The approval review's round 6 findings (PR #201), as tests the PR keeps. Each asserts the safe answer, so each was red on
// round 6 and is green with the round 7 fix. The HIGH runs real git in a temporary folder through a Node port of fs.rs
// locate_path, the lookup the hook uses. The one finding left as it was (MED-D) pins the current rule, as Ash decides it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { approvalVerdict } from "./decide";
import { editInside, ignoresCase, pathWithin, placeStaysInside, safeCommand, type Canonical, type Locate, type RealPlace } from "./safeApproval";
import { credentialBlock } from "../../../integrations/harness/core/credentialGuard";

/** The git environment the app's own lookups run under (fs.rs git_safe_env): command-line config, so a repo's cannot undo it. */
const APP_GIT_ENV = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" };

/**
 * fs.rs locate_path(path, follow_last = true), in Node: links followed, the checkout from `git rev-parse --show-toplevel`
 * run under the app's git environment, and `dotGit` as fs.rs sets it (the checkout's root holds `.git`).
 */
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
      top = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { env: APP_GIT_ENV, stdio: ["ignore", "pipe", "pipe"] })
        .toString()
        .replace(/[\r\n]+$/, "");
    } catch (error) {
      if (String((error as { stderr?: Buffer }).stderr ?? "").includes("not a git repository")) return null;
      throw error;
    }
    const repo = fs.realpathSync(top);
    if (actual !== repo && !actual.startsWith(`${repo}/`)) throw new Error("outside its checkout");
    return {
      root: top,
      relative: actual === repo ? "" : actual.slice(repo.length + 1),
      linked: !!entry?.isSymbolicLink(),
      dotGit: fs.existsSync(path.join(top, ".git")),
    };
  });

/** fs.rs canonical_place, in Node: every link followed; a path that doesn't exist yet is placed by its nearest existing parent. */
const realCanonical: Canonical = async (paths) =>
  paths.map((p) => {
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
    // The long form of each name (realpath.native, as Rust's canonicalize gives on Windows), so the folder and the
    // landing path are spelled the same way.
    return path.join(fs.realpathSync.native(existing), ...missing);
  });

/** A lookup for a chat outside every checkout: nothing is in git. */
const outsideGit: Locate = async (paths) => paths.map(() => null);

const bash = (command: string) => ({ text: "", tool: { title: command, kind: "execute" }, approval: { call: { tool: "Bash", command, folderPinned: true } } }) as any;
const write = (file: string) => ({ text: "", tool: { title: "Write", kind: "edit" }, approval: { call: { tool: "Write", paths: [file] } } }) as any;

/** The whole approval path the hook runs: the words, then the app's lookup. */
async function verdict(block: any, folder: string): Promise<"allow" | "held"> {
  const words = approvalVerdict(block, folder, undefined, new Set());
  if (words.kind === "held") return "held";
  return (await placeStaysInside(block.approval.call, folder, realLocate, realCanonical)) ? "held" : "allow";
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r201r7-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/**
 * The git folder's own files a planted repository needs, with an fsmonitor and a diff.external that write a marker. The
 * marker is a relative name: git runs both in the worktree, the chat's own folder, so it is written there, with no drive
 * letter or backslash for git's shell to read (round 7, Windows CI).
 */
function plantGitFolder(chat: string) {
  fs.mkdirSync(`${chat}/objects`, { recursive: true });
  fs.mkdirSync(`${chat}/refs`, { recursive: true });
  fs.writeFileSync(`${chat}/objects/readme`, "x\n");
  fs.writeFileSync(`${chat}/refs/readme`, "x\n");
  fs.writeFileSync(`${chat}/HEAD`, "ref: refs/heads/main\n");
  fs.writeFileSync(
    `${chat}/config`,
    `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = "echo ran > ran.txt; false"\n[diff]\n\texternal = "echo ran > ran.txt"\n`,
  );
}

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

  it("holds a write of a git folder's own files, under any folder of the chat, wherever it lands", () => {
    const folder = "/Users/example/Projects/mono/packages/app";
    for (const name of ["HEAD", "head", "sub/HEAD", "config", "packed-refs", "commondir", "gitdir", "objects/readme", "refs/heads/main", "sub/refs/x"]) {
      expect(approvalVerdict(write(`${folder}/${name}`), folder, undefined, new Set()).kind, name).toBe("held");
    }
  });

  it("runs the app's git with safe.bareRepository=explicit, so a planted folder's fsmonitor and diff.external never run", () => {
    const repo = `${TMP}/proof/mono`;
    const chat = `${repo}/packages/app`;
    const marker = `${chat}/ran.txt`;
    fs.mkdirSync(`${chat}/src`, { recursive: true });
    fs.writeFileSync(`${chat}/src/app.ts`, "x\n");
    execFileSync("git", ["init", "-q", repo]);
    plantGitFolder(chat);
    // Control: without the app's environment, git takes the planted folder for its repository and runs the program. Checked
    // on macOS and Linux only: Git for Windows' bundled shell did not run the planted program in this harness, so on
    // win32 this one assertion is skipped. The "never runs under the environment" assertion below runs on every platform.
    if (process.platform !== "win32") {
      try {
        execFileSync("git", ["-C", chat, "status"], { stdio: "ignore" });
      } catch {
        // The planted fsmonitor exits non-zero by design; only the marker matters.
      }
      expect(fs.existsSync(marker), "control: the planted program runs without the app's environment").toBe(true);
    }
    fs.rmSync(marker, { force: true });
    // The app's own lookup and a status and diff under its environment: the planted program does not run, and the
    // lookup places the chat in the real checkout.
    // Under the app's environment git refuses the planted folder as a bare repository (an error, which the lookup holds on),
    // so the lookup either fails or finds the real checkout. It never finds the planted folder.
    let top: string | null = null;
    try {
      top = execFileSync("git", ["-C", chat, "rev-parse", "--show-toplevel"], { env: APP_GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    } catch (error) {
      expect(String((error as { stderr?: Buffer }).stderr ?? "")).toContain("bare repository");
    }
    if (top !== null) expect(fs.realpathSync(top)).toBe(fs.realpathSync(repo));
    for (const args of [["status"], ["diff"]]) {
      try {
        execFileSync("git", ["-C", chat, ...args], { env: APP_GIT_ENV, stdio: "ignore" });
      } catch {
        // A non-zero exit is not the planted program running; only the marker is judged.
      }
    }
    expect(fs.existsSync(marker), "the planted program ran under the app's git environment").toBe(false);
  });

  it("holds git commands in a checkout whose root has no .git folder or file", async () => {
    const locate: Locate = async (paths) => paths.map((p) => ({ root: "/Users/example/proj", relative: p.endsWith(".monocode-autopilot-probe") ? ".monocode-autopilot-probe" : "x", dotGit: false }));
    expect(await placeStaysInside(bash("git status").approval.call, "/Users/example/proj/app", locate)).not.toBeNull();
    expect(await placeStaysInside(bash("ls").approval.call, "/Users/example/proj/app", locate)).toBeNull();
  });
});

describe("MED: words that read outside the folder but look inside", () => {
  const FOLDER = "/Users/example/proj";
  const PROBE = ".monocode-autopilot-probe";
  const locateWith =
    (map: Record<string, RealPlace | null>): Locate =>
    async (paths) =>
      paths.map((p) => (p.endsWith(PROBE) ? { root: FOLDER, relative: PROBE, dotGit: true } : p in map ? map[p] : { root: FOLDER, relative: p.slice(FOLDER.length + 1), dotGit: true }));

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
    const locate = locateWith({ [`${FOLDER}/vendor/app.ts`]: { root: "/Users/example/other", relative: "src/app.ts", linked: false, dotGit: true } });
    expect(await placeStaysInside({ tool: "Bash", command: "cat vendor/app.ts" } as any, FOLDER, locate)).not.toBeNull();
    expect(await placeStaysInside({ tool: "Read", paths: [`${FOLDER}/vendor/app.ts`] } as any, FOLDER, locate)).not.toBeNull();
  });

  // MED-D (Ash's decision, not changed in round 7): a Read by an absolute path into another checkout is allowed while the
  // same words in a shell command wait. This pins that rule, so a change to it is a deliberate one.
  it("keeps the current rule for a Read by an absolute path into another checkout (MED-D, Ash decides)", async () => {
    const locate = locateWith({ "/Users/example/other/config/prod.yml": { root: "/Users/example/other", relative: "config/prod.yml", dotGit: true } });
    expect(safeCommand("cat /Users/example/other/config/prod.yml", FOLDER)).not.toBeNull();
    expect(await placeStaysInside({ tool: "Read", paths: ["/Users/example/other/config/prod.yml"] } as any, FOLDER, locate)).toBeNull();
  });

  it("blocks the hub database read with the space escaped by a backslash (the guard that holds even with a yes)", () => {
    for (const command of [
      "cat ~/Library/Application\\ Support/com.ash.monocode-hub/monocode.db",
      "sqlite3 ~/Library/Application\\ Support/com.ash.monocode-hub/monocode.d\\b .dump",
    ]) {
      expect(credentialBlock({ tool: "Bash", command }, "/Users/example/Projects/x"), command).toBeDefined();
    }
  });
});

describe("LOW: ag reads compressed files with -z, as rg -z does", () => {
  it("holds ag -z and --search-zip", () => {
    expect(safeCommand("ag -z token src", "/Users/example/proj")).not.toBeNull();
    expect(safeCommand("ag --search-zip token src", "/Users/example/proj")).not.toBeNull();
  });
});

describe("LOW: a timer at home reads no file it names", () => {
  it("holds a timer's plain read of a bare file name in a folder that can't hold a walk, and allows it in a project", () => {
    expect(safeCommand("grep -c X Documents/f", "/Users/example", true)).not.toBeNull();
    expect(safeCommand("grep -c X src/app.ts", "/Users/example/proj", true)).toBeNull();
    // A git subcommand is no file name, so a timer at home can still check its status.
    expect(safeCommand("git status", "/Users/example", true)).toBeNull();
    // A chat (not a timer) keeps its own rule.
    expect(safeCommand("grep -c X Documents/f", "/Users/example/proj")).toBeNull();
  });
});

// Round 7, Windows CI: the containment comparison is pure, so it runs the Windows shapes on every OS.
describe("containment compares whole path components, the same on every platform", () => {
  const folder = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\r201r7-x\\outside\\chat";

  it("reads a Windows drive path, a forward-slash path and a verbatim \\\\?\\ path the same way", () => {
    expect(pathWithin(`${folder}\\src\\app.ts`, folder)).toBe(true);
    expect(pathWithin("C:/Users/runneradmin/AppData/Local/Temp/r201r7-x/outside/chat/src/app.ts", folder)).toBe(true);
    expect(pathWithin(`\\\\?\\${folder}\\src\\app.ts`, folder)).toBe(true);
    expect(pathWithin(`\\\\?\\${folder}`, folder)).toBe(true);
  });

  it("folds case where the file system ignores it (Windows, and the Mac's own folders), and only there", () => {
    expect(ignoresCase(folder)).toBe(true);
    expect(ignoresCase("/Users/example/chat")).toBe(true);
    expect(ignoresCase("/home/example/chat")).toBe(false);
    expect(pathWithin(`${folder.toUpperCase()}\\src\\app.ts`, folder)).toBe(true);
    expect(pathWithin("/home/example/CHAT/a.ts", "/home/example/chat", false)).toBe(false);
  });

  it("is not fooled by a string prefix or a sibling folder", () => {
    expect(pathWithin("C:\\Users\\r\\chat2\\a.ts", "C:\\Users\\r\\chat")).toBe(false);
    expect(pathWithin("C:\\Users\\r\\other\\a.ts", "C:\\Users\\r\\chat")).toBe(false);
    expect(pathWithin("/home/example/chat2/a.ts", "/home/example/chat", false)).toBe(false);
  });

  it("holds a short name against a long one: both sides must be canonical, which the app's lookup makes them", () => {
    expect(pathWithin("C:\\Users\\runneradmin\\chat\\a.ts", "C:\\Users\\RUNNER~1\\chat")).toBe(false);
  });

  it("places a Windows edit inside its folder, and holds a git folder's own file there", () => {
    expect(editInside(`${folder}\\src\\new.ts`, folder)).toBeNull();
    expect(editInside(`${folder}\\HEAD`, folder)).not.toBeNull();
    expect(editInside(`${folder}\\..\\other.ts`, folder)).not.toBeNull();
  });

  it("allows a Windows chat outside git whose canonical paths are backslashed, and holds a link out of it", async () => {
    const toWindows: Canonical = async (paths) => paths.map((p) => p.replace(/\//g, "\\"));
    const outside: Canonical = async (paths) => paths.map((p) => (p.endsWith("linked.ts") ? "C:\\Users\\runneradmin\\Secret\\s.txt" : p.replace(/\//g, "\\")));
    // Round 10: a relative path waits (the tool resolves it against its own folder), so only the absolute form is allowed.
    expect(await placeStaysInside({ tool: "Write", paths: ["src\\new.ts"] } as any, folder, outsideGit, toWindows)).not.toBeNull();
    expect(await placeStaysInside({ tool: "Write", paths: [`${folder}\\src\\new.ts`] } as any, folder, outsideGit, toWindows)).toBeNull();
    expect(await placeStaysInside({ tool: "Read", paths: ["src\\linked.ts"] } as any, folder, outsideGit, outside)).not.toBeNull();
  });
});

describe("usability: a chat outside git is judged by where each path really lands", () => {
  // path.join so a Windows temp (`C:\Users\RUNNER~1\...`) is not held for a forward slash. The folder's own short name is
  // not a hold either (round 13): the check looks only at the part below the folder.
  const chat = path.join(TMP, "outside", "chat");
  fs.mkdirSync(path.join(chat, "src"), { recursive: true });
  fs.writeFileSync(path.join(chat, "src", "app.ts"), "x\n");
  fs.writeFileSync(path.join(TMP, "outside", "secret.txt"), "x\n");
  fs.symlinkSync(path.join(TMP, "outside", "secret.txt"), path.join(chat, "src", "linked.ts"));

  it("allows a read and an edit that stay inside the folder", async () => {
    expect(await placeStaysInside({ tool: "Bash", command: "cat src/app.ts" } as any, chat, outsideGit, realCanonical)).toBeNull();
    expect(await placeStaysInside({ tool: "Write", paths: [path.join(chat, "src", "new.ts")] } as any, chat, outsideGit, realCanonical)).toBeNull();
  });

  it("holds a link that escapes the folder, and a read or edit that can't be placed", async () => {
    expect(await placeStaysInside({ tool: "Read", paths: [path.join(chat, "src", "linked.ts")] } as any, chat, outsideGit, realCanonical)).not.toBeNull();
    expect(await placeStaysInside({ tool: "Bash", command: "cat src/linked.ts" } as any, chat, outsideGit, realCanonical)).not.toBeNull();
    expect(await placeStaysInside({ tool: "Write", paths: [path.join(chat, "src", "linked.ts")] } as any, chat, outsideGit, realCanonical)).not.toBeNull();
    expect(await placeStaysInside({ tool: "Bash", command: "cat src/app.ts" } as any, chat, outsideGit)).not.toBeNull();
  });

  it("holds a git folder's own file and any git command, since git has no checkout here", async () => {
    expect(await placeStaysInside({ tool: "Write", paths: [path.join(chat, "HEAD")] } as any, chat, outsideGit, realCanonical)).not.toBeNull();
    expect(await placeStaysInside({ tool: "Bash", command: "git status" } as any, chat, outsideGit, realCanonical)).not.toBeNull();
  });
});
