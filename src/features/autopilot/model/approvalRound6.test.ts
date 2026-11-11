// WP-101 review round 6 (PR #201): HIGH-1 (a Bash word that resolves outside the chat's folder is held, and the login
// stores that were missing from the places list), MED-3 (process files other than environ and cmdline), and the LOW
// items (rg's -z, the guard's own source as a run). MED-1 is in approvalRound6.links.test.ts; MED-2 in agentAppTimers.test.ts.
import { describe, expect, it } from "vitest";
import { approvalVerdict } from "./decide";
import { credentialInPaths, credentialPath } from "./credentialPaths";
import { commandNamesLogin, editInside, safeCall, safeCommand } from "./safeApproval";

const FOLDER = "/Users/example/proj";
const bash = (command: string) => ({ text: "", tool: { title: command, kind: "execute" }, approval: { call: { tool: "Bash", command, folderPinned: true } } }) as any;
const tool = (name: string, call: Record<string, unknown>) => ({ text: "", tool: { title: name, kind: "read" }, approval: { call: { tool: name, ...call } } }) as any;
const held = (block: any, folder = FOLDER) => expect(approvalVerdict(block, folder)).toMatchObject({ kind: "held" });
const allowed = (block: any, folder = FOLDER) => expect(approvalVerdict(block, folder)).toMatchObject({ kind: "allow" });

describe("HIGH-1: a Bash read that names a place outside the chat's folder waits", () => {
  it("holds the reads the review named by absolute path (the hub's database copies, the stores, the browsers)", () => {
    for (const command of [
      "ls /Users/example/Archive/monocode/ships",
      "cat /Users/example/Archive/monocode/ships/abc123/backup/monocode.db",
      "grep -a -o -E 'sk-ant-\\S+' /Users/example/Archive/monocode/backups-20261110/monocode.db",
      "tail -c 50000 /Users/example/Archive/monocode/ships/abc123/monocode.db-wal",
      "head -c 400000 '/Users/example/Library/WebKit/com.ash.monocode-h'ub/WebsiteData/localstorage.sqlite3",
      "cat ~/Library/HTTPStorages/com.ash.app/cookies.binarycookies",
      'ls "~/Library/Group Containers"',
      "cat ~/Library/Messages/chat.db",
      "cat ~/Library/Accounts/Accounts4.sqlite",
      "cat ~/Library/Containers/com.example.app/Data/state.db",
      'cat "C:/Users/example/AppData/Roaming/Mozilla/Firefox/Profiles/p1/logins.json"',
      'cat "C:/Users/example/AppData/Roaming/discord/Local Storage/leveldb/000003.log"',
      'cat "C:/Users/example/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Network/Cookies"',
      'cat "C:/Users/example/AppData/Roaming/Code/User/globalStorage/state.vscdb"',
    ]) {
      held(bash(command));
    }
  });

  it("holds a relative read of the same stores inside the chat's folder, because the places now name them", () => {
    for (const path of [
      "Library/WebKit/com.ash.monocode-hub/WebsiteData/localstorage.sqlite3",
      "Library/HTTPStorages/com.ash.app/cookies.binarycookies",
      "Library/Group Containers/group.example/data.db",
      "Library/Messages/chat.db",
      "Library/Accounts/Accounts4.sqlite",
      "Library/Containers/com.example.app/Data/state.db",
      "AppData/Roaming/Mozilla/Firefox/Profiles/p1/logins.json",
      "AppData/Roaming/discord/Local Storage/leveldb/000003.log",
      "AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Network/Cookies",
      "AppData/Roaming/Code/User/globalStorage/state.vscdb",
    ]) {
      expect(credentialPath(path), path).toBe(true);
      held(bash(`cat "${path}"`));
    }
  });

  it("holds an edit or a Read of those places too", () => {
    expect(editInside(`${FOLDER}/Library/Messages/chat.db`, FOLDER)).toBeNull();
    expect(credentialInPaths(["Library/Messages/chat.db"], FOLDER)).not.toBeNull();
    expect(credentialInPaths([`${FOLDER}/Library/WebKit/x`], FOLDER)).not.toBeNull();
  });

  it("holds a word that climbs out of the folder, however it is written", () => {
    held(bash("cat ../../other/notes.txt"));
    held(bash("rg -n secret ../.."));
    held(bash("cat ~/x"));
    held(bash("cat -- /etc/hosts"));
    held(bash("cat --file=/etc/hosts"));
    held(bash("cat 'C:\\Users\\ash\\notes.txt'"));
    held(bash("cat '\\\\server\\share\\x'"));
  });

  it("still allows the reads a chat does: its own files, absolute paths inside the folder, and plain searches", () => {
    allowed(bash("cat docs/notes.txt"));
    allowed(bash("cat /Users/example/proj/src/app.ts"));
    allowed(bash("rg -n token src"));
    allowed(bash("git show HEAD:src/app.ts"));
    allowed(bash("git diff HEAD~1 -- src/app.ts"));
    allowed(bash("ls -la src"));
    allowed(bash("git status"));
  });

  it("with no folder known, a rooted or climbing read waits (nothing shows it is inside)", () => {
    expect(safeCommand("cat /etc/hosts")).not.toBeNull();
    expect(safeCommand("cat ../x")).not.toBeNull();
    expect(safeCommand("cat docs/notes.txt")).toBeNull();
  });
});

describe("MED-3: process files other than environ and cmdline wait", () => {
  it("holds a process's per-thread environment and its file descriptors, by a path inside the folder", () => {
    for (const command of [
      "cat proc/123/task/123/environ",
      "cat proc/123/task/456/cmdline",
      "cat proc/123/task/123/cwd",
      "cat proc/123/fd/3",
      "cat proc/self/fd/0",
      "cat proc/self/map_files/7f00-7f01",
      "cat proc/self/mem",
    ]) {
      held(bash(command));
      // A timer's verdict is its table and walk, then its login words (agentAppTimers.ts).
      expect(safeCommand(command, FOLDER, true) ?? commandNamesLogin(command), command).not.toBeNull();
    }
  });

  it("holds the same files named as a Read's path, and the absolute form", () => {
    for (const path of ["/proc/123/task/123/environ", "/proc/123/fd/3", "/proc/self/mem", "/proc/self/map_files/x", "proc/1/task/1/root"]) {
      expect(credentialInPaths([path], FOLDER), path).not.toBeNull();
      held(tool("Read", { paths: [path] }));
    }
  });
});

describe("LOW: rg's -z and the guard's own source", () => {
  it("holds rg's search-zip in every form, as it holds -L and --follow", () => {
    for (const command of ["rg -z token src", "rg -nz token src", "rg --search-zip token src", "rg -L token src", "rg --follow token src"]) {
      expect(safeCommand(command, FOLDER), command).not.toBeNull();
    }
    expect(safeCommand("rg -n token src", FOLDER)).toBeNull();
  });

  it("holds an edit of each file that runs the guard or the agents' hooks (the guard's own source)", () => {
    for (const path of [
      "vite.config.mts",
      "vite.config.js",
      "src-tauri/src/watcher/checks.rs",
      "src-tauri/src/watcher/mod.rs",
      "src-tauri/src/fs.rs",
      "src/platform/tauri/fs.ts",
      "src/features/agent-app/model/agentAppTimers.ts",
      "src/integrations/harness/providers/claude/claude.ts",
      "src/integrations/harness/core/registry.ts",
    ]) {
      expect(editInside(path, FOLDER), path).not.toBeNull();
      expect(safeCall({ tool: "Edit", paths: [path] } as any, FOLDER), path).not.toBeNull();
    }
    expect(editInside(`${FOLDER}/src/app.ts`, FOLDER)).toBeNull();
  });
});
