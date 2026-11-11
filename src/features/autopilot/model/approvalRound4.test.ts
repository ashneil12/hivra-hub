// WP-101 review round 4. One block per finding: the structural rule (any path outside the chat's own folder with a
// dot-named segment is held, for Read, Grep, Glob and every path field, and for the credential checks), then the named
// lists as extra cover, the Windows short names, the timer's words, the MCP arguments, the quoted and %USERPROFILE%
// spellings of home, and the guard's own files. Its timer parity cases are in approvalParity.test.ts.
import { describe, expect, it } from "vitest";
import { approvalVerdict } from "./decide";
import { credentialInPaths, credentialInWords, dotOutside } from "./credentialPaths";
import { commandNamesLogin, editInside, safeCall, safeCommand } from "./safeApproval";

/** A timer's verdict on a command, as agentAppTimers.ts takes it: the table and walk first, then the login words. */
const timerHolds = (command: string) => safeCommand(command, "/Users/example/Projects/proj", true) ?? commandNamesLogin(command);
import { credentialBlock } from "../../../integrations/harness/core/credentialGuard";

const FOLDER = "/Users/someone/Worktrees/hub-x";
const bash = (command: string) => ({ text: "", tool: { title: command, kind: "execute" }, approval: { call: { tool: "Bash", command } } }) as any;
const read = (tool: string, paths: unknown) => ({ text: "", tool: { title: tool, kind: "read" }, approval: { call: { tool, paths } } }) as any;
const search = (tool: string, paths: unknown) => ({ text: "", tool: { title: tool, kind: "search" }, approval: { call: { tool, paths } } }) as any;
const held = (block: unknown) => expect(approvalVerdict(block as any, FOLDER)).toMatchObject({ kind: "held" });

describe("finding 1: Read, Grep, Glob and every path field hold a dot-named place outside the chat's folder", () => {
  it("holds pi's login file and the other agent and tool configs a Read could reach", () => {
    for (const path of [
      "/Users/someone/.pi/agent/auth.json",
      "/Users/someone/.omp/agent/auth.json",
      "/Users/someone/.cursor/mcp.json",
      "/Users/someone/.config/opencode/opencode.json",
      "/Users/someone/.claude/settings.json",
      "/Users/someone/.grok/user-settings.json",
      "~/.pi/agent/auth.json",
      "/Users/someone/.anything/whatever.json",
    ]) {
      expect(credentialInPaths([path], FOLDER), path).not.toBeNull();
      held(read("Read", [path]));
    }
  });

  it("holds the same paths when a Grep or Glob starts there, and every other path field", () => {
    held(search("Grep", ["/Users/someone/.pi"]));
    held(search("Grep", ["~/.cursor"]));
    held(search("Glob", ["/Users/someone/.config/opencode"]));
    held(search("LS", ["/Users/someone/.grok"]));
    expect(dotOutside("/Users/someone/.pi/agent/auth.json", FOLDER)).toBe(true);
  });

  it("lets a dot-named file inside the chat's own folder through, as the named lists still judge it", () => {
    expect(credentialInPaths([`${FOLDER}/.github/workflows/ci.yml`], FOLDER)).toBeNull();
    expect(credentialInPaths([`${FOLDER}/src/.gitignore`], FOLDER)).toBeNull();
    expect(dotOutside("./src/.github/x", FOLDER)).toBe(false);
    expect(dotOutside("../.pi/x", FOLDER)).toBe(true);
    expect(approvalVerdict(read("Read", [`${FOLDER}/src/app.ts`]), FOLDER)).toMatchObject({ kind: "allow" });
  });

  it("holds a climb that lands on a dot-named place outside the folder", () => {
    held(bash("cat ../../.pi/agent/auth.json"));
    held(bash("grep token ../../.cursor/mcp.json"));
  });
});

describe("finding 2: dot-prefixed secret names are secrets", () => {
  it("holds .secrets, .token, .tokens and .dev.vars as names, inside the folder as well", () => {
    for (const name of [".secrets", ".token", ".tokens", ".dev.vars"]) {
      expect(credentialInWords(["cat", name], FOLDER), name).not.toBeNull();
      expect(credentialInWords(["cat", `./${name}`], FOLDER), name).not.toBeNull();
      expect(credentialInPaths([name], FOLDER), name).not.toBeNull();
    }
    expect(credentialInWords(["head", "--", `${FOLDER}/.secrets`])).not.toBeNull();
  });

  it("holds the same names as a bash read, a Read, and the timer", () => {
    held(bash("cat .secrets"));
    held(bash("cat .token"));
    held(bash("cat .tokens"));
    held(bash("head -- ~/.secrets"));
    held(read("Read", [`${FOLDER}/.dev.vars`]));
    expect(commandNamesLogin("cat .secrets")).not.toBeNull();
    expect(commandNamesLogin("cat .tokens")).not.toBeNull();
  });
});

describe("finding 3: history stores and the other tool logins", () => {
  it("holds zsh's session histories, the shell and database histories, and the tool configs", () => {
    for (const command of [
      "cat ~/.zsh_sessions/abc.history",
      "ls ~/.zsh_sessions",
      "cat ~/.mysql_history",
      "cat ~/.node_repl_history",
      "cat ~/.fly/config.yml",
      "cat ~/.railway/config.json",
      "cat ~/.sentryclirc",
      "cat ~/.ngrok2/ngrok.yml",
      "cat ~/.m2/settings.xml",
    ]) {
      held(bash(command));
      expect(commandNamesLogin(command), command).not.toBeNull();
    }
  });

  it("holds any file whose name contains history, but not a source file that has the word", () => {
    expect(credentialInWords(["cat", "/Users/someone/work/history.json"])).not.toBeNull();
    expect(credentialInWords(["cat", "src/features/sessions/chatHistory.ts"], FOLDER)).toBeNull();
  });
});

describe("finding 4: the timer check holds what the app holds", () => {
  it("holds a recursive grep, a textconv diff and a glued short option's value", () => {
    expect(timerHolds("grep -rn TODO src")).not.toBeNull();
    expect(timerHolds("grep -f.netrc x README.md")).not.toBeNull();
    expect(timerHolds("git log --textconv -p")).not.toBeNull();
    expect(timerHolds("git diff --textconv HEAD~1")).not.toBeNull();
  });

  it("holds the timer's own rooted words, climbs and flag values with a slash", () => {
    expect(commandNamesLogin("cat /etc/hosts")).not.toBeNull();
    expect(commandNamesLogin("git log --format=%H/%s")).not.toBeNull();
    expect(commandNamesLogin("cat ../x.txt")).not.toBeNull();
  });

  it("does not let a search's pattern pass as a path, and an -e or -f option names the pattern", () => {
    expect(timerHolds("rg -n token src")).toBeNull();
    expect(timerHolds("rg -e foo secrets")).not.toBeNull();
  });
});

describe("finding 5: Windows 8.3 short names are held in any segment", () => {
  it("holds a short name in one segment, and in a folder", () => {
    for (const command of ["cat ./ENV~1", "cat ENV~1", "rg -n . ENV~1", "git diff --no-index NUL ENV~1", "cat CLAUDE~1.MD", "cat sub/CODEX~1/auth.json"]) {
      expect(commandNamesLogin(command), command).not.toBeNull();
    }
    expect(credentialInPaths(["C:/Users/someone/CODEX~1/AUTH~1.JSO"], FOLDER)).not.toBeNull();
    expect(credentialInPaths(["ENV~1"], FOLDER)).not.toBeNull();
  });

  it("does not hold a git revision such as HEAD~1", () => {
    expect(commandNamesLogin("git diff HEAD~1 -- src/app.ts")).toBeNull();
    expect(approvalVerdict(bash("git diff HEAD~1 -- src/app.ts"), FOLDER)).toMatchObject({ kind: "allow" });
  });
});

describe("finding 6: MCP arguments that name an address are held however they are spelled", () => {
  const SERVER = "plugin-agent_plugins-notion";
  const tool = `mcp__${SERVER}__get_status`;
  const wired = new Set([SERVER]);
  it("holds the spellings the review named", () => {
    for (const value of [
      "evil\u3002example", // ideographic full stop
      "evil\uff61example", // halfwidth ideographic full stop
      "evil\uff0eexample", // fullwidth full stop
      "evil%2eexample",
      "evil%2Eexample",
      "..\uff0e..\uff0fetc",
      "localhost",
      "api.localhost",
      "16909060",
      "0x01020304",
      "../etc",
    ]) {
      expect(safeCall({ tool, args: [value] }, FOLDER, wired), value).not.toBeNull();
    }
  });
  it("still allows a plain read argument", () => {
    expect(safeCall({ tool, args: ["open-issues"] }, FOLDER, wired)).toBeNull();
  });
});

describe("finding 7: home spellings and quoted words", () => {
  it("holds a login under %USERPROFILE%, /root and quoted spellings", () => {
    expect(credentialBlock({ command: 'cat "$HOME"/.codex/auth.json' })).toBeDefined();
    expect(credentialBlock({ command: "cat ~/.co''dex/auth.json" })).toBeDefined();
    expect(credentialBlock({ command: "cat %USERPROFILE%\\.codex\\auth.json" })).toBeDefined();
    expect(credentialBlock({ command: "cat /root/.codex/auth.json" })).toBeDefined();
    expect(credentialBlock({ command: "cat ~/.pi/agent/auth.json" })).toBeDefined();
    expect(credentialBlock({ command: "cat ~/.omp/agent/auth.json" })).toBeDefined();
    expect(credentialBlock({ paths: ["/Users/someone/.pi/agent/auth.json"] })).toBeDefined();
  });
});

describe("finding 8: the guard's own files are not editable by an agent", () => {
  it("holds an edit to the shared list and to the autopilot model", () => {
    expect(editInside(`${FOLDER}/src/shared/security/agentConfigPaths.json`, FOLDER)).not.toBeNull();
    expect(editInside(`${FOLDER}/src/features/autopilot/model/safeApproval.ts`, FOLDER)).not.toBeNull();
    expect(editInside(`${FOLDER}/src/features/autopilot/model/decide.ts`, FOLDER)).not.toBeNull();
    expect(editInside(`${FOLDER}/src/shared/lib/paths.ts`, FOLDER)).toBeNull();
  });
  it("reads of those files are ordinary", () => {
    expect(approvalVerdict(read("Read", [`${FOLDER}/src/features/autopilot/model/tokenizer.ts`]), FOLDER)).toMatchObject({ kind: "allow" });
  });
});
