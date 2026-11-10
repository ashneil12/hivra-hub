// What autopilot allows by itself on a tool approval: reads, a short list of checks with nothing chained or expanded,
// and edits inside the chat's own folder. Everything else waits for Ash.
import { describe, expect, it } from "vitest";
import { editInside, editStaysInside, safeCall, safeCommand, type Locate } from "./safeApproval";
import { shellWords } from "./shellWords";

const FOLDER = "/Users/someone/Worktrees/hub-x";

describe("shell commands", () => {
  it.each([
    "git status",
    "git status --porcelain",
    "git diff HEAD~1 -- src/app.ts",
    "git log --oneline -20",
    "git show HEAD:src/app.ts",
    "git branch",
    "git branch -a -v",
    "git branch --list 'hub/*'",
    "git branch --contains abc123",
    "ls -la src",
    "cat README.md",
    "rg -n 'foo bar' src",
    'rg "fn main" src-tauri',
    "rg foo src",
    "grep -n TODO README.md",
    "head -50 src/app.ts",
    "wc -l src/app.ts",
    "pwd",
    "cargo fmt --check",
    "cargo fmt --all --check",
    // WP-101: the wider read-only table (Row-Bot's safe commands, with their unsafe options held below).
    "find . -name '*.ts'",
    "find src -type f -newer README.md",
    "find . -maxdepth 2 -name '*.md' -print0",
    "fd foo",
    "fd -e ts foo",
    "fd --type f foo",
    "tree src",
    "tree -L 2 -a src",
    "stat README.md",
    "stat -f '%z' README.md",
    "du -sh src",
    "df -h",
    "file README.md",
    "which git",
    // WP-101 fix round 2, item C: ps only as `ps -p <pid> -o <fields>` with `-o` required and a fixed field list.
    "ps -p 501 -o pid,ppid,etime,state,stat,%cpu,%mem,rss",
    "ps -p 501 -o pid",
  ])("runs by itself: %s", (command) => {
    expect(safeCommand(command)).toBeNull();
  });

  it.each([
    // chained, substituted, redirected, piped, backgrounded
    "git status; rm -rf ~/data",
    "git status && rm -rf ~/data",
    "git status || true",
    "git status & rm -rf ~/data",
    "echo cm0gLXJmIH4vZGF0YQ== | base64 -d | sh",
    // even quoted: a pipe, a semicolon or a dollar anywhere waits
    "rg -n 'foo|bar' src",
    "cat $(echo ~/.ssh/id_rsa)",
    "cat `echo x`",
    "cat ${HOME}/x",
    "git log > out.txt",
    "cat < /etc/passwd",
    "git status\nrm -rf ~/data",
    "(rm -rf ~/data)",
    // not on the list
    `python3 -c "import shutil; shutil.rmtree('backups')"`,
    "gh pr merge 12 --admin",
    "rm -rf build",
    "npx vitest run",
    "/usr/bin/git status",
    "CI=1 npm test",
    "git push origin main",
    "git checkout main",
    "git -C /elsewhere status",
    // options that run something else, write elsewhere, or change files
    "rg --pre=sh foo",
    "rg --pre sh foo",
    "rg '--pre=sh' foo",
    "rg --p\\re=sh foo",
    "rg --hostname-bin=/tmp/x foo",
    // WP-101 fix round 3, finding 5: a build that abbreviates long options would run --pr as --pre, and --pr-glob as
    // --pre-glob. --pretty is not --pre, but it abbreviates the same way, so it waits too.
    "rg --pr echo",
    "rg --pr-glob '*.txt' foo",
    "rg --pr-glob='*.txt' foo",
    "rg --pretty foo",
    "git diff --output=/Users/someone/.zshrc",
    "git log --ext-diff",
    "git branch -D main",
    "git branch --delete main",
    "git log --textconv",
    "git diff --textconv HEAD",
    "git branch -f main HEAD~3",
    "git branch new-branch",
    "npm test --script-shell=/tmp/evil",
    "npm run check --prefix ../other",
    "npm run deploy",
    "npm install",
    "cargo fmt",
    "cargo test --config build.rustc-wrapper=/tmp/evil",
    "cargo clippy --fix --allow-dirty",
    "cargo test --manifest-path /elsewhere/Cargo.toml",
    "cargo +nightly test",
    "cargo run",
    "node -e 'require(\"fs\").rmSync(\"x\")'",
    "node --test --import=./evil.mjs",
    "node --test --require ./evil.js",
    "node scripts/anything.mjs",
    // expansions that could turn a file name into an option
    "rg foo *",
    "rg foo {--pre=sh,.}",
    "ls ^x",
    // the wider table's commands, with the options that make them write or run another program
    "find . -delete",
    "find . -fdelete",
    "find . -execdir sh",
    "find . -ok rm",
    // WP-101 fix round: every shell experiment from the review's "tried and correctly held" section, kept as a
    // regression. An option however it is spelled, a wrapper in front of it, and every run or write shape.
    "find . '-DELETE'",
    "find . -e\\xec sh",
    "find . -name x -exec echo {} \\;",
    "find . -prune -o -name '*.ts' -exec rm {} +",
    "FOO=bar find .",
    "env find .",
    "sudo find .",
    "nice find .",
    "time find .",
    "xargs find",
    "fd --exe sh",
    "fd --exec-batch sh",
    "fd -xx sh",
    "fd -X -e ts foo",
    "tree -H . -o out.txt",
    "tree -ofile",
    "tree -o=x",
    "file -C -m magic",
    "ag --pager ls",
    "du -sh *",
    "find . -fprint out.txt",
    "find . -fprintf out.txt %p",
    "find . -fls out.txt",
    "fd -x sh",
    "fd -X sh",
    "fd -Hx sh",
    "fd --exec sh",
    "fd --ex sh",
    "fd --exec-batch sh",
    "tree -o out.txt",
    "tree -ao out.txt",
    "file -c magic",
    "file --compile magic",
    // an unquoted wildcard could expand into an option
    "find . -name *.ts",
    // WP-101 fix round 2, item C: a bare `ps -p <pid>` prints the process's full command line on macOS, with its
    // arguments, so it waits too. `ps e` and `ps eww` print every process's environment; `aux` and `-ef` every
    // command line.
    "ps -p 1",
    "ps -p 501",
    "ps -p 501 -o comm",
    "ps -p 501 -o pid,comm",
    "ps",
    "ps -p 501 -o args",
    "ps -p 501 -o pid,command",
    "ps aux",
    "ps -ef",
    "ps e",
    "ps eww",
    "ps auxe",
    "ps ewwf",
    "ps e -p 1",
    "ps -E",
    "ps -e",
    "ps -eo pid,args",
    "ps ax -o command -ww",
    "ps -p 501 -ww",
    "ps -p 501 -o command",
    "ps -p 501 -o pid,environ",
    "ps -p 501 -o pid -e",
    "ps -p 501 e",
    "ps -p 501 -E",
    "ps -p abc",
    "ps -p 501 502",
    "ps -p",
    "ps -p 501 -o",
    "ps -p 501 --pid 502",
    "ps -o pid",
    "ps -p 501 -o pid -o command",
    // can't be read plainly
    "cat 'unclosed",
  ])("waits for Ash: %s", (command) => {
    expect(safeCommand(command)).not.toBeNull();
  });

  it("never throws, and never finds a command in Object's own methods", () => {
    // The review's row 21: `COMMANDS[name]` found Object.prototype methods, so valueOf threw a TypeError.
    for (const name of ["valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toString", "toLocaleString", "constructor", "__proto__", "__defineGetter__"])
      expect(safeCommand(name), name).toMatch(/isn't a read/);
    // A command shape it can't read is a hold, never an exception.
    for (const command of ["", "   ", "\\", "'", '"', "ps -p 1 -o ", "ps -p 1 -o ,"]) expect(safeCommand(command), command).not.toBeNull();
  });

  it("holds a call whose tool isn't text, instead of throwing", () => {
    for (const tool of [null, 7, {}, []]) {
      const call = { tool } as unknown as { tool: string };
      expect(safeCall(call, FOLDER), JSON.stringify(tool)).not.toBeNull();
    }
  });

  it("reads words as sh does", () => {
    expect(shellWords(`rg -n 'a b' "c\\"d" e\\ f`)).toEqual(["rg", "-n", "a b", 'c"d', "e f"]);
    expect(shellWords("rg foo *")).toBeNull();
    expect(shellWords("cat 'x")).toBeNull();
  });

  it("reads an unsafe option however the program would: quoted, abbreviated, clustered or with a value", () => {
    for (const command of [
      "find . '-delete'",
      "find . -fprint0 out.txt",
      "fd '--exec' sh",
      "fd --ex sh",
      "fd -e ts -x sh",
      "fd -X sh",
      "fd -eX sh",
      "tree --output=out.txt",
      "file '-C'",
      "file --comp x",
    ])
      expect(safeCommand(command), command).not.toBeNull();
  });

  it("keeps an ordinary option that merely starts like an unsafe one", () => {
    // -L and -a are not -o, and --depth is not --delete.
    for (const command of ["tree -L 2 -a src", "find . --depth 2 -name '*.md'", "du -d 2 src"])
      expect(safeCommand(command), command).toBeNull();
  });

  // WP-101 fix round 3, finding 4: GNU find takes a unique prefix of a predicate, so -del is -delete and -okd is
  // -okdir. Anything starting with "-" that is not a known read-only predicate waits. A number after a test (-mtime
  // -7) is an operand, and -executable, -d and -print are not -exec, -delete and -fprint.
  it("holds a find predicate it does not know is read-only, including a short prefix (fix round 3, finding 4)", () => {
    for (const command of [
      "find . -del",
      "find . -okd echo hi",
      "find . -exe echo",
      "find . -execd echo",
      "find . -delet",
      "find . -okdi echo",
      "find . -fpri out.txt",
      "find . -fprint out.txt",
      "find . -fl out.txt",
      "find . -L",
      "find . -follow",
      "find . -xtype f",
      "find . -files0-from list",
      "find . '-DELETE'",
    ])
      expect(safeCommand(command), command).not.toBeNull();
    for (const command of [
      "find . -name '*.ts'",
      "find src -type f -newer README.md",
      "find . -maxdepth 2 -name '*.md' -print0",
      "find . -d -name '*.ts'",
      "find . -depth -print",
      "find . -executable",
      "find . -mtime -7 -type f",
      "find . -size -10k -print",
    ])
      expect(safeCommand(command), command).toBeNull();
  });

  // WP-101 fix round 3, finding 2: grep has no ignore list once it recurses, and a search that turns ignores off reads
  // what a project keeps out of git. Both wait even inside the chat's folder. --no-heading is not --no-ignore.
  it("holds recursive grep and a search that turns ignores off (fix round 3, finding 2)", () => {
    for (const command of [
      "grep -rn TODO src",
      "grep -r BEGIN .",
      "grep -R BEGIN .",
      "grep --recursive BEGIN .",
      "grep -d recurse BEGIN .",
      "grep --directories=recurse BEGIN .",
      "grep --directories recurse BEGIN .",
      "rg -u foo src",
      "rg -uu . .",
      "rg -uuu . .",
      "rg --no-ignore . .",
      "rg --no-ignore-vcs foo src",
      "rg --hidden foo src",
      "fd --hidden --type f foo",
    ])
      expect(safeCommand(command, FOLDER), command).not.toBeNull();
    expect(safeCommand("rg foo src", FOLDER)).toBeNull();
    expect(safeCommand("grep -n TODO README.md", FOLDER)).toBeNull();
    expect(safeCommand("rg --no-heading foo src", FOLDER)).toBeNull();
  });
});

describe("edits", () => {
  it("are allowed inside the chat's folder only", () => {
    expect(editInside(`${FOLDER}/src/a.ts`, FOLDER)).toBeNull();
    expect(editInside("src/a.ts", FOLDER)).toBeNull();
    expect(editInside(`${FOLDER}/src/../README.md`, `${FOLDER}/`)).toBeNull();
    for (const path of [`${FOLDER}/../hub-y/a.ts`, `${FOLDER}-other/a.ts`, "/Users/someone/.zshrc", "~/.zshrc", "../escape.ts", FOLDER, "/"])
      expect(editInside(path, FOLDER), path).not.toBeNull();
  });

  it("never touch what changes how tools run, and never from a folder too broad to be the chat's own", () => {
    for (const path of [".git/config", ".git/hooks/pre-commit", ".claude/settings.json", ".mcp.json", ".npmrc", ".envrc", ".husky/pre-commit", ".vscode/tasks.json", ".cargo/config.toml", "sub/.git/config", "node_modules/pkg/index.js"])
      expect(editInside(`${FOLDER}/${path}`, FOLDER), path).not.toBeNull();
    expect(editInside("/Users/someone/notes.md", "/Users/someone")).not.toBeNull();
    expect(editInside("/Users/someone/notes.md", "~")).not.toBeNull();
    expect(editInside("/tmp/x/a.ts", undefined)).not.toBeNull();
  });
});

describe("MCP tools", () => {
  const SERVER = "plugin-agent_plugins-notion";
  const plugin = (tool: string) => `mcp__${SERVER}__${tool}`;
  /** The servers Hivra really wired for this chat, as the app reports them. */
  const wired = new Set([SERVER]);

  it("allows a read from a server the person installed as a plugin", () => {
    for (const tool of ["get_status", "list_issues", "search_issues", "get_issue", "list_pull_requests", "list_branches", "get_commit"])
      expect(safeCall({ tool: plugin(tool) }, FOLDER, wired), tool).toBeNull();
  });

  it("holds a page, URL, file or path tool whose arguments the request never carries (fix round 2, item E)", () => {
    // The same trusted server; a name like this can only be judged once the call says what it is pointed at.
    for (const tool of ["get_page", "read_page", "search_docs", "read_file", "get_file", "list_files", "get_url", "fetch_url", "query", "run_sql", "run_shell"])
      expect(safeCall({ tool: plugin(tool) }, FOLDER, wired), tool).not.toBeNull();
  });

  it("holds a plugin server's tool that changes anything, or that can't be placed", () => {
    for (const tool of ["create_page", "update_settings", "delete_file", "send_message", "frobnicate"])
      expect(safeCall({ tool: plugin(tool) }, FOLDER, wired), tool).not.toBeNull();
    // A hostile server can give a write tool a reading name; a change by name still waits.
    expect(safeCall({ tool: plugin("delete_page") }, FOLDER, wired)).not.toBeNull();
  });

  it("holds every tool from a server Hivra didn't install, however it reads", () => {
    for (const tool of ["mcp__slack__reply_to_thread", "mcp__slack__get_messages", "mcp__claude_ai_Firecrawl__firecrawl_scrape", "mcp__monocode__delegate_task", "mcp__notion__get_page", "mcp__plugin-__get_x"])
      expect(safeCall({ tool }, FOLDER, wired), tool).not.toBeNull();
  });

  it("holds a server whose name merely claims the plugin prefix", () => {
    // The review's row 2: a project's own .mcp.json names a server plugin-evil-srv, and its tools read like reads.
    for (const tool of ["mcp__plugin-evil-srv__get_x", "mcp__plugin-evil-srv__get_page", "mcp__plugin-evil-srv__list_files"])
      expect(safeCall({ tool }, FOLDER, wired), tool).not.toBeNull();
    // The same name as a wired server, from a config that isn't the wiring: still held.
    expect(safeCall({ tool: "mcp__plugin-agent_plugins-notion__get_page" }, FOLDER, new Set())).not.toBeNull();
  });

  it("trusts nothing when no set is given or the set can't be read", () => {
    for (const trusted of [undefined, null, new Set<string>()])
      expect(safeCall({ tool: plugin("get_page") }, FOLDER, trusted)).not.toBeNull();
  });

  it("holds a call whose name it can't split into a server and a tool", () => {
    for (const tool of ["mcp__", "mcp____x", "mcp__x__", "mcp_x__y"]) expect(safeCall({ tool }, FOLDER, wired), tool).not.toBeNull();
  });
});

describe("tool calls", () => {
  it("allow read-only tools, edits in the folder and listed commands; hold the rest", () => {
    expect(safeCall({ tool: "Read", paths: ["/etc/hosts"] }, FOLDER)).toBeNull();
    for (const tool of ["Grep", "Glob", "LS", "WebSearch"]) expect(safeCall({ tool }, FOLDER), tool).toBeNull();
    expect(safeCall({ tool: "Edit", paths: [`${FOLDER}/a.ts`] }, FOLDER)).toBeNull();
    expect(safeCall({ tool: "Write", paths: [`${FOLDER}/a.ts`, "/etc/hosts"] }, FOLDER)).not.toBeNull();
    expect(safeCall({ tool: "Edit" }, FOLDER)).not.toBeNull();
    expect(safeCall({ tool: "Bash", command: "git status" }, FOLDER)).toBeNull();
    expect(safeCall({ tool: "Bash", command: "npm test" }, FOLDER)).not.toBeNull();
    expect(safeCall({ tool: "Bash" }, FOLDER)).not.toBeNull();
    // A tool whose name merely reads like a read (it "read"s in "thread") is not one.
    expect(safeCall({ tool: "mcp__slack__reply_to_thread" }, FOLDER)).not.toBeNull();
    expect(safeCall({ tool: "Task" }, FOLDER)).not.toBeNull();
    expect(safeCall(undefined, FOLDER)).not.toBeNull();
  });
});

describe("where an edit really lands", () => {
  // The app's lookup (fs.rs git_locate_files): `shared` inside the folder is a link to the main checkout.
  const MAIN = "/Users/someone/Projects/hub";
  const lookup: Locate = async (paths) =>
    paths.map((path) => {
      if (path.startsWith("/tmp/")) return null;
      if (path.startsWith(`${FOLDER}/shared/`)) return { root: MAIN, relative: `shared/${path.slice(`${FOLDER}/shared/`.length)}` };
      return path.startsWith(`${FOLDER}/`) ? { root: FOLDER, relative: path.slice(FOLDER.length + 1) } : { root: "/", relative: path.slice(1) };
    });
  const edit = (...paths: string[]) => ({ tool: "Edit", paths });

  it("follows links: an edit that leaves the folder through one waits", async () => {
    expect(await editStaysInside(edit(`${FOLDER}/src/a.ts`, "src/b.ts"), FOLDER, lookup)).toBeNull();
    expect(await editStaysInside(edit(`${FOLDER}/shared/config.ts`), FOLDER, lookup)).toBe(`it edits ${MAIN}/shared/config.ts, outside the chat's folder`);
    expect(await editStaysInside(edit(`${FOLDER}/src/a.ts`, `${FOLDER}/shared/x.ts`), `${FOLDER}/`, lookup)).not.toBeNull();
  });

  it("waits when the app can't place the folder or a file, or the lookup fails; anything but an edit isn't its to check", async () => {
    expect(await editStaysInside(edit("/tmp/x/a.ts"), "/tmp/x", lookup)).toContain("couldn't place the chat's folder");
    expect(await editStaysInside(edit("/tmp/y/a.ts"), FOLDER, lookup)).toContain("couldn't place /tmp/y/a.ts");
    const broken: Locate = async () => {
      throw new Error("not in the app");
    };
    expect(await editStaysInside(edit(`${FOLDER}/a.ts`), FOLDER, broken)).toContain("couldn't find where it really edits (not in the app)");
    expect(await editStaysInside({ tool: "Bash", command: "npm test" }, FOLDER, broken)).toBeNull();
    expect(await editStaysInside(undefined, FOLDER, broken)).toBeNull();
  });
});

// WP-101 review: the fixes for C1, H3, H4, M1, M3 and the cheap lows. Each test fails before its fix.
const SRV_R = "plugin-agent_plugins-notion";
const mcpR = (tool: string) => `mcp__${SRV_R}__${tool}`;
const wiredR = new Set([SRV_R]);
describe("review fixes: what autopilot may run and touch", () => {
  // C1: a test or build can run the code an allowed edit just wrote (package.json scripts, a test file), so none of
  // them is allowed by itself, wherever the chat is.
  it.each([
    "npm test",
    "npm test -- src/features/autopilot",
    "npm run check",
    "npm run build",
    "cargo test",
    "cargo check --workspace",
    "cargo clippy --all-targets -- -D warnings",
    "node --test scripts/hub-dev.test.mjs",
    "node --test --test-reporter-destination=/tmp/x.log",
  ])("holds a test or build that runs code the chat wrote: %s (review C1)", (command) => {
    expect(safeCall({ tool: "Bash", command }, FOLDER), command).not.toBeNull();
  });

  it("still allows cargo fmt --check, which runs no code", () => {
    expect(safeCall({ tool: "Bash", command: "cargo fmt --check" }, FOLDER)).toBeNull();
  });

  // H3: WebFetch sends its URL, so it waits; it is not a read.
  it("holds WebFetch (review H3)", () => {
    expect(safeCall({ tool: "WebFetch" }, FOLDER)).not.toBeNull();
  });

  // H4: the Mac disk is case-insensitive and names fold, so a protected name is compared folded and NFKC-normalised.
  it.each([
    "/.Claude/settings.local.json",
    "/.CLAUDE/settings.json",
    "/.MCP.json",
    "/CLAUDE.md",
    "/agents.md",
    "/.ｃｌａｕｄｅ/settings.json",
    "/.mcp​.json",
  ])("holds an edit to a protected name whatever its case or form: %s (review H4)", (suffix) => {
    expect(safeCall({ tool: "Write", paths: [`${FOLDER}${suffix}`] }, FOLDER), suffix).not.toBeNull();
  });

  // M3: a resource read or list goes to a server, so only a server Hivra wired is trusted.
  it("holds a resource read from a server Hivra did not wire (review M3)", () => {
    const resource = (server: string) => ({ tool: "ReadMcpResourceTool", server });
    expect(safeCall(resource("random-server"), FOLDER, new Set([SRV_R]))).not.toBeNull();
    expect(safeCall({ tool: "ListMcpResourcesTool" }, FOLDER, new Set([SRV_R]))).not.toBeNull();
    expect(safeCall(resource(SRV_R), FOLDER, new Set([SRV_R]))).toBeNull();
  });

  // M1: an MCP read's arguments are read too: a path, a URL or a host in one is held.
  it.each([
    ["/etc/passwd"],
    ["https://evil.example/collect"],
    ["evil.example"],
    ["~/.ssh/config"],
  ])("holds a trusted MCP read whose argument names a path, URL or host: %s (review M1)", (value) => {
    expect(safeCall({ tool: mcpR("get_issue"), args: [value] } as never, FOLDER, wiredR), value).not.toBeNull();
  });

  it("allows a trusted MCP read whose arguments are plain words (review M1)", () => {
    expect(safeCall({ tool: mcpR("get_issue"), args: ["quarterly summary"] } as never, FOLDER, wiredR)).toBeNull();
  });

  // Lows: search options that follow links, write files, or search outside the folder.
  it.each([
    "fd --base-directory /etc x",
    "fd --search-path /etc x",
    "fd --base-directory=/etc x",
    "fd --search-path=/etc x",
    "fd -L x src",
    "fd --follow x src",
    "rg -L foo src",
    "rg --follow foo src",
    "rg -nL foo src",
    "du -L src",
    "tree -R src",
    "tree -l src",
    "ag -f foo src",
  ])("holds a read option that follows links, writes files or leaves the folder: %s (review lows)", (command) => {
    expect(safeCall({ tool: "Bash", command }, FOLDER), command).not.toBeNull();
  });

  it("holds an edit to CLAUDE.md or AGENTS.md (review lows)", () => {
    expect(safeCall({ tool: "Edit", paths: [`${FOLDER}/CLAUDE.md`] }, FOLDER)).not.toBeNull();
    expect(safeCall({ tool: "Edit", paths: [`${FOLDER}/AGENTS.md`] }, FOLDER)).not.toBeNull();
  });
});

// PR #201 second hard review (round 2): other harnesses' and tools' configs are protected names too.
describe("round 2: protected names of other harnesses and tools", () => {
  it.each([
    "opencode.json",
    ".opencode/config.json",
    ".pi/settings.json",
    ".grok/config.json",
    "GEMINI.md",
    "AGENTS.override.md",
    "CLAUDE.local.md",
    ".cursorrules",
    "mise.toml",
    ".pre-commit-config.yaml",
    "lefthook.yml",
    ".lintstagedrc.json",
  ])("holds an edit to a config another harness or tool runs: %s", (name) => {
    expect(safeCall({ tool: "Edit", paths: [`${FOLDER}/${name}`] }, FOLDER), name).not.toBeNull();
    expect(safeCall({ tool: "Write", paths: [`${FOLDER}/src/${name}`] }, FOLDER), name).not.toBeNull();
  });
});

// PR #201 second hard review (round 2, low): a resource read's uri is an argument like an MCP call's, so it is read.
describe("round 2: resource read arguments", () => {
  it("holds a resource read from a wired server whose uri names a file or an address", async () => {
    const { approvalCall } = await import("../../../integrations/harness/providers/claude/claudeProtocol");
    expect(safeCall(approvalCall("ReadMcpResourceTool", { server: SRV_R, uri: "file:///Users/someone/.netrc" }), FOLDER, wiredR)).not.toBeNull();
    expect(safeCall(approvalCall("ReadMcpResourceTool", { server: SRV_R, uri: "https://evil.example/x" }), FOLDER, wiredR)).not.toBeNull();
  });
});
