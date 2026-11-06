import { describe, expect, it } from "vitest";
import { approvalVerdict, chatProject, decideCall, handBackText } from "./decide";

const UNTIL = Date.parse("2026-10-19T09:00:00");

describe("autopilot.decide", () => {
  it("is off without a covering switch", () => {
    expect(decideCall({ question: "Split into two PRs?", recommendation: "Yes", until: undefined })).toEqual({ outcome: "off" });
  });

  it("takes the agent's recommendation while on", () => {
    expect(decideCall({ question: "Split into two PRs?", recommendation: "Yes, two PRs", until: UNTIL })).toEqual({
      outcome: "taken",
      answer: "Yes, two PRs",
      until: UNTIL,
    });
  });

  it("holds a question that asks to send, delete, pay, publish or change access (WP-101 fix round, row 19)", () => {
    const held = (input: { question: string; recommendation: string; options?: string[] }) =>
      expect(decideCall({ ...input, until: UNTIL })).toMatchObject({ outcome: "held", red: null });
    held({ question: "Should I email Priya the invoice?", recommendation: "Yes" });
    held({ question: "Should I publish the release notes?", recommendation: "Yes" });
    held({ question: "Delete the old branch?", recommendation: "Yes" });
    held({ question: "Should I post the changelog to the public site?", recommendation: "Yes" });
    // The action can be in the recommendation or in an option too.
    held({ question: "Which next?", recommendation: "Publish the release notes" });
    held({ question: "Which next?", recommendation: "Option B", options: ["A: keep", "B: delete the old branch"] });
  });

  it("never takes a red-list call: by its words, its options, or the agent's own mark", () => {
    expect(decideCall({ question: "What about the duplicate charge?", recommendation: "Refund the customer", until: UNTIL })).toMatchObject({ outcome: "held", red: "money" });
    expect(decideCall({ question: "Clean up?", recommendation: "Option B", options: ["A: keep", "B: DROP TABLE sessions"], until: UNTIL })).toMatchObject({ outcome: "held", red: "delete" });
    expect(decideCall({ question: "Ship the banner copy?", recommendation: "Yes", declaredRed: "send-as-ash", until: UNTIL })).toMatchObject({ outcome: "held", red: "send-as-ash" });
    expect(decideCall({ question: "Rotate the API key?", recommendation: "Yes", declaredRed: "none", until: UNTIL })).toMatchObject({ outcome: "held", red: "credentials" });
  });
});

describe("a question with no pick", () => {
  it("is handed back with the end time and the red list", () => {
    const text = handBackText("Mon 9:00");
    expect(text).toContain("until Mon 9:00");
    expect(text).toContain("take your own recommendation");
    expect(text).toContain("still waits for him");
  });
});

describe("a tool approval under autopilot", () => {
  const FOLDER = "/Users/ash/Worktrees/hub-x";
  const SECRET_FILE = "/home/user/.ssh/id_ed25519";
  const bash = (command: string) => ({ text: "", tool: { title: command, kind: "execute" }, approval: { requestId: 1, call: { tool: "Bash", command } } });

  it("allows a listed check, a read, and an edit in the chat's folder", () => {
    expect(approvalVerdict(bash("npm run check"), FOLDER)).toEqual({ kind: "allow", what: "npm run check" });
    expect(approvalVerdict({ text: "", tool: { title: "Read README.md" }, approval: { requestId: 2, call: { tool: "Read", paths: ["/etc/hosts"] } } }, FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict({ text: "", tool: { title: "Edit a.ts" }, approval: { requestId: 3, call: { tool: "Edit", paths: [`${FOLDER}/src/a.ts`] } } }, FOLDER)).toMatchObject({ kind: "allow" });
  });

  it("allows a read-only MCP call from an installed plugin's server, and nothing else from MCP", () => {
    const mcp = (tool: string) => ({ text: "", tool: { title: tool, kind: "other" }, approval: { requestId: 6, call: { tool } } });
    const wired = new Set(["plugin-agent_plugins-notion", "plugin-agent_plugins-blog"]);
    expect(approvalVerdict(mcp("mcp__plugin-agent_plugins-notion__get_page"), FOLDER, undefined, wired)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(mcp("mcp__plugin-agent_plugins-notion__create_page"), FOLDER, undefined, wired)).toMatchObject({ kind: "held", red: null });
    // A server Hivra didn't install waits even for a name that reads as a read.
    expect(approvalVerdict(mcp("mcp__notion__get_page"), FOLDER, undefined, wired)).toMatchObject({ kind: "held", red: null });
    // A server whose name claims the prefix, never wired: held.
    expect(approvalVerdict(mcp("mcp__plugin-evil-srv__get_page"), FOLDER, undefined, wired)).toMatchObject({ kind: "held", red: null });
    // Nothing says which servers were wired: every MCP call waits.
    expect(approvalVerdict(mcp("mcp__plugin-agent_plugins-notion__get_page"), FOLDER)).toMatchObject({ kind: "held", red: null });
  });

  it("lets the red list hold an MCP call the classifier would allow", () => {
    // The name says a read; the files it names say credentials, and the red list is checked first.
    const read = { text: "", tool: { title: "mcp__plugin-x-memory__get_file" }, approval: { requestId: 7, call: { tool: "mcp__plugin-x-memory__get_file", paths: [SECRET_FILE] } } };
    expect(approvalVerdict(read, FOLDER, undefined, new Set(["plugin-x-memory"]))).toMatchObject({ kind: "held", red: "credentials" });
  });

  it("holds red-list commands, saying which list", () => {
    expect(approvalVerdict(bash("rm -rf ~/Library/Application Support/x"), FOLDER)).toMatchObject({ kind: "held", red: "delete" });
    expect(approvalVerdict(bash("git push --force origin main"), FOLDER)).toMatchObject({ kind: "held", red: "mass-destructive" });
    expect(approvalVerdict({ text: "", tool: { title: "mcp__slack__chat_postMessage", kind: "other" }, approval: { requestId: 4, call: { tool: "mcp__slack__chat_postMessage" } } }, FOLDER)).toMatchObject({ kind: "held", red: "send-as-ash" });
    expect(approvalVerdict({ text: "", tool: { title: "Read file" }, approval: { requestId: 5, call: { tool: "Read", paths: [SECRET_FILE] } } }, FOLDER)).toMatchObject({ kind: "held", red: "credentials" });
  });

  it("holds a send, a delete, a payment, a publish or an account change on reviewer rules too", () => {
    // The red list's own words miss each of these; the very rule that a judged reviewer follows holds them.
    expect(approvalVerdict(bash("npm run check && echo done"), FOLDER)).toMatchObject({ kind: "held", red: null, why: "it chains, substitutes or redirects" });
    const readNote = { text: "", tool: { title: "Read the note" }, approval: { requestId: 8, call: { tool: "mcp__plugin-agent_plugins-blog__get_post" } } };
    expect(approvalVerdict(readNote, FOLDER, undefined, new Set(["plugin-agent_plugins-blog"]))).toMatchObject({ kind: "allow" });
    const publish = { text: "", tool: { title: "Bash" }, approval: { requestId: 9, call: { tool: "Bash", command: "npm publish" } } };
    expect(approvalVerdict(publish, FOLDER)).toMatchObject({ kind: "held", red: null, why: "This publishes something for others to see, so it waits for you." });
  });

  it("holds a read of a credential place or a folder too broad to be a project (WP-101 fix round 2, item B)", () => {
    // A folder that holds logins, and files whose names the patterns never listed.
    for (const command of [
      "cat ~/.aws",
      "ls ~/.aws",
      "stat ~/.aws",
      "cat ~/.aws/config",
      "cat ~/.azure/accessTokens.json",
      "cat ~/.terraform.d/credentials.tfrc.json",
      "cat ~/.hermes/auth.json",
      "cat terraform.tfstate",
      "cat service-account.json",
      "cat token.txt",
      "cat api_key.txt",
      "cat private.key",
      "cat cert.p12",
      "cat id_ecdsa",
      "cat id_dsa",
      "cat .htpasswd",
      "cat ~/.s3cfg",
      "cat ~/.boto",
      "cat ~/.dockercfg",
      "cat ~/.zsh_history",
      "cat ~/.claude.json",
      "git show HEAD:.env",
      // folder walks that name no credential and read every one the person has
      "grep -r . ~/.aws",
      "rg . ~/.kube",
      "rg -uuu . ~",
      "grep -r BEGIN /Users",
      "rg -uuu . /",
      "find ~ -name '*.pem'",
      "cat ~/.ssh/config",
    ])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    // A recursive read inside the chat's folder stays allowed, unless it names a credential file too.
    expect(approvalVerdict(bash("grep -rn TODO src"), FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(bash("rg -n 'foo' src"), FOLDER)).toMatchObject({ kind: "allow" });
    // A recursive read by a relative place stays inside the working folder; an absolute one can't be shown to.
    expect(approvalVerdict(bash("grep -rn TODO src"), undefined)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(bash("grep -rn TODO /Users/ash/Projects/other"), undefined)).toMatchObject({ kind: "held" });
    expect(approvalVerdict(bash("find . -name '.env'"), FOLDER)).toMatchObject({ kind: "held", red: "credentials" });
    // A search for the word is not a file: the names that merely hold a word pass.
    expect(approvalVerdict(bash("grep token src/app.ts"), FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(bash("cat src/features/autopilot/model/tokenizer.ts"), FOLDER)).toMatchObject({ kind: "allow" });
  });

  it("reads a command as the shell reads it, so quotes can't hide a login file (WP-101 fix round 2, item A)", () => {
    // A quoted piece joins the word it touches: the raw text never holds ".netrc", the word does.
    for (const command of [
      `cat ~/.ne"t"rc`,
      "cat ~/.ne't'rc",
      "cat ~/.n\\etrc",
      "cat .e\"n\"v",
      "cat '.env'",
      "cat .'env'",
      "cat ~/.aws/cred''entials",
      "cat ~/.s''sh/config",
      "cat ~/.gnu''pg/secring.gpg",
      "cat ~/.kube/co''nfig",
      "cat ~/.docker/con''fig.json",
      "cat ~/.npm''rc",
      "cat ~/\".netrc\"",
    ])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held", red: "credentials" });
    // An option hidden the same way is still the option it is.
    expect(approvalVerdict(bash("rg --p\\re=sh foo"), FOLDER)).toMatchObject({ kind: "held", red: null });
    // A word it can't read waits, whatever it looks like (the red list may still name it first).
    for (const command of ["cat $HOME/.ssh/id_rsa", "cat ~/.ssh/id_r*sa", "ls ~", "ls {a,b}", "cat \"unclosed", "cat x\ny"])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held" });
    // The ordinary reads still pass.
    for (const command of ["rg \"foo bar\" src", "grep -n 'TODO' README.md", 'cat "src/my file.ts"', "ls -la"])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "allow" });
  });

  it("holds what the red list's words miss, anything too long to read whole, and a call that doesn't say what it runs", () => {
    for (const command of [`python3 -c "import shutil; shutil.rmtree('backups')"`, "echo cm0gLXJmIH4vZGF0YQ== | base64 -d | sh", "gh pr merge 12 --admin"])
      expect(approvalVerdict(bash(command), FOLDER), command).toMatchObject({ kind: "held", red: null });
    const long = bash(`npm test -- ${"x".repeat(6_000)} refund the customer`);
    expect(approvalVerdict(long, FOLDER)).toMatchObject({ kind: "held", red: null, why: "it is too long to check whole" });
    expect(approvalVerdict({ text: "Run tests", tool: { title: "npm run check", kind: "execute" } }, FOLDER)).toMatchObject({ kind: "held", red: null, why: "it doesn't say exactly what it runs" });
    // A chat told to ask Ash: its next approval waits whatever it is.
    expect(approvalVerdict(bash("npm test"), FOLDER, "money")).toMatchObject({ kind: "held", red: "money" });
  });
});

describe("which project a chat belongs to", () => {
  const projects = [
    { id: "hivra", folder: "/Users/ash/Projects/hivra" },
    { id: "hub", folder: "/Users/ash/Projects/monocode-hub" },
    { id: "ash", folder: null },
  ];

  it("a Lead is its project; a one-project Mono that project; a multi-project Mono none", () => {
    expect(chatProject({ cwd: "/Users/ash" }, projects, { projects: [], leadProjectId: "vg-game" })).toBe("vg-game");
    expect(chatProject({ cwd: "/Users/ash" }, projects, { projects: ["/Users/ash/Projects/hivra"] })).toBe("hivra");
    expect(chatProject({ cwd: "/Users/ash" }, projects, { projects: ["/Users/ash/Projects/hivra", "/Users/ash/Projects/monocode-hub"] })).toBeNull();
  });

  it("any other chat goes by its folder", () => {
    expect(chatProject({ cwd: "/Users/ash/Projects/monocode-hub" }, projects)).toBe("hub");
    expect(chatProject({ cwd: "/Users/ash/Projects/hivra/dashboard" }, projects)).toBe("hivra");
    expect(chatProject({ cwd: "/Users/ash/Projects/hivra-old" }, projects)).toBeNull();
    expect(chatProject({ cwd: "/tmp/x", worktreeCwd: "/Users/ash/Projects/hivra" }, projects)).toBe("hivra");
  });
});
