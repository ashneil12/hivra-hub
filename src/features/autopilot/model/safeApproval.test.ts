// What autopilot allows by itself on a tool approval: reads, a short list of checks with nothing chained or expanded,
// and edits inside the chat's own folder. Everything else waits for Ash.
import { describe, expect, it } from "vitest";
import { editInside, safeCall, safeCommand, shellWords } from "./safeApproval";

const FOLDER = "/Users/ash/Worktrees/hub-x";

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
    "grep -rn TODO src",
    "head -50 src/app.ts",
    "wc -l src/app.ts",
    "pwd",
    "npm test",
    "npm test -- src/features/autopilot",
    "npm run check",
    "npm run lint",
    "npm run build",
    "npm run check:web",
    "cargo test",
    "cargo test -p monocode --lib autopilot",
    "cargo check --workspace",
    "cargo clippy --all-targets -- -D warnings",
    "cargo fmt --check",
    "cargo fmt --all --check",
    "node --test scripts/hub-dev.test.mjs",
    "node --test 'scripts/**/*.test.mjs'",
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
    "git diff --output=/Users/ash/.zshrc",
    "git log --ext-diff",
    "git branch -D main",
    "git branch --delete main",
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
    // can't be read plainly
    "cat 'unclosed",
  ])("waits for Ash: %s", (command) => {
    expect(safeCommand(command)).not.toBeNull();
  });

  it("reads words as sh does", () => {
    expect(shellWords(`rg -n 'a b' "c\\"d" e\\ f`)).toEqual(["rg", "-n", "a b", 'c"d', "e f"]);
    expect(shellWords("rg foo *")).toBeNull();
    expect(shellWords("cat 'x")).toBeNull();
  });
});

describe("edits", () => {
  it("are allowed inside the chat's folder only", () => {
    expect(editInside(`${FOLDER}/src/a.ts`, FOLDER)).toBeNull();
    expect(editInside("src/a.ts", FOLDER)).toBeNull();
    expect(editInside(`${FOLDER}/src/../README.md`, `${FOLDER}/`)).toBeNull();
    for (const path of [`${FOLDER}/../hub-y/a.ts`, `${FOLDER}-other/a.ts`, "/Users/ash/.zshrc", "~/.zshrc", "../escape.ts", FOLDER, "/"])
      expect(editInside(path, FOLDER), path).not.toBeNull();
  });

  it("never touch what changes how tools run, and never from a folder too broad to be the chat's own", () => {
    for (const path of [".git/config", ".git/hooks/pre-commit", ".claude/settings.json", ".mcp.json", ".npmrc", ".envrc", ".husky/pre-commit", ".vscode/tasks.json", ".cargo/config.toml", "sub/.git/config"])
      expect(editInside(`${FOLDER}/${path}`, FOLDER), path).not.toBeNull();
    expect(editInside("/Users/ash/notes.md", "/Users/ash")).not.toBeNull();
    expect(editInside("/Users/ash/notes.md", "~")).not.toBeNull();
    expect(editInside("/tmp/x/a.ts", undefined)).not.toBeNull();
  });
});

describe("tool calls", () => {
  it("allow read-only tools, edits in the folder and listed commands; hold the rest", () => {
    expect(safeCall({ tool: "Read", paths: ["/etc/hosts"] }, FOLDER)).toBeNull();
    for (const tool of ["Grep", "Glob", "LS", "WebSearch", "WebFetch"]) expect(safeCall({ tool }, FOLDER), tool).toBeNull();
    expect(safeCall({ tool: "Edit", paths: [`${FOLDER}/a.ts`] }, FOLDER)).toBeNull();
    expect(safeCall({ tool: "Write", paths: [`${FOLDER}/a.ts`, "/etc/hosts"] }, FOLDER)).not.toBeNull();
    expect(safeCall({ tool: "Edit" }, FOLDER)).not.toBeNull();
    expect(safeCall({ tool: "Bash", command: "npm test" }, FOLDER)).toBeNull();
    expect(safeCall({ tool: "Bash" }, FOLDER)).not.toBeNull();
    // A tool whose name merely reads like a read (it "read"s in "thread") is not one.
    expect(safeCall({ tool: "mcp__slack__reply_to_thread" }, FOLDER)).not.toBeNull();
    expect(safeCall({ tool: "Task" }, FOLDER)).not.toBeNull();
    expect(safeCall(undefined, FOLDER)).not.toBeNull();
  });
});
