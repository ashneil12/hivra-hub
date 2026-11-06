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
  const FOLDER = "/Users/ash/Projects/hivra";
  const bash = (command: string) => ({ text: "", tool: { title: command, kind: "execute" }, approval: { requestId: 1, call: { tool: "Bash", command } } });

  it("allows a listed check, a read, and an edit in the chat's folder", () => {
    expect(approvalVerdict(bash("npm run check"), FOLDER)).toEqual({ kind: "allow", what: "npm run check" });
    expect(approvalVerdict({ text: "", tool: { title: "Read README.md" }, approval: { requestId: 2, call: { tool: "Read", paths: ["/etc/hosts"] } } }, FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict({ text: "", tool: { title: "Edit a.ts" }, approval: { requestId: 3, call: { tool: "Edit", paths: [`${FOLDER}/src/a.ts`] } } }, FOLDER)).toMatchObject({ kind: "allow" });
  });

  it("allows a read-only MCP call from an installed plugin's server, and nothing else from MCP", () => {
    const mcp = (tool: string) => ({ text: "", tool: { title: tool, kind: "other" }, approval: { requestId: 6, call: { tool } } });
    expect(approvalVerdict(mcp("mcp__plugin-agent_plugins-notion__get_page"), FOLDER)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(mcp("mcp__plugin-agent_plugins-notion__create_page"), FOLDER)).toMatchObject({ kind: "held", red: null });
    // A server Hivra didn't install waits even for a name that reads as a read.
    expect(approvalVerdict(mcp("mcp__notion__get_page"), FOLDER)).toMatchObject({ kind: "held", red: null });
  });

  it("lets the red list hold an MCP call the classifier would allow", () => {
    // The name says a read; the files it names say credentials, and the red list is checked first.
    const read = { text: "", tool: { title: "mcp__plugin-x-memory__get_file" }, approval: { requestId: 7, call: { tool: "mcp__plugin-x-memory__get_file", paths: ["/Users/ash/.ssh/id_ed25519"] } } };
    expect(approvalVerdict(read, FOLDER)).toMatchObject({ kind: "held", red: "credentials" });
  });

  it("holds red-list commands, saying which list", () => {
    expect(approvalVerdict(bash("rm -rf ~/Library/Application Support/x"), FOLDER)).toMatchObject({ kind: "held", red: "delete" });
    expect(approvalVerdict(bash("git push --force origin main"), FOLDER)).toMatchObject({ kind: "held", red: "mass-destructive" });
    expect(approvalVerdict({ text: "", tool: { title: "mcp__slack__chat_postMessage", kind: "other" }, approval: { requestId: 4, call: { tool: "mcp__slack__chat_postMessage" } } }, FOLDER)).toMatchObject({ kind: "held", red: "send-as-ash" });
    expect(approvalVerdict({ text: "", tool: { title: "Read file" }, approval: { requestId: 5, call: { tool: "Read", paths: ["/Users/ash/.ssh/id_ed25519"] } } }, FOLDER)).toMatchObject({ kind: "held", red: "credentials" });
  });

  it("holds a send, a delete, a payment, a publish or an account change on reviewer rules too", () => {
    // The red list's own words miss each of these; the very rule that a judged reviewer follows holds them.
    expect(approvalVerdict(bash("npm run check && echo done"), FOLDER)).toMatchObject({ kind: "held", red: null, why: "it chains, substitutes or redirects" });
    const readNote = { text: "", tool: { title: "Read the note" }, approval: { requestId: 8, call: { tool: "mcp__plugin-agent_plugins-blog__get_post" } } };
    expect(approvalVerdict(readNote, FOLDER)).toMatchObject({ kind: "allow" });
    const publish = { text: "", tool: { title: "Bash" }, approval: { requestId: 9, call: { tool: "Bash", command: "npm publish" } } };
    expect(approvalVerdict(publish, FOLDER)).toMatchObject({ kind: "held", red: null, why: "This publishes something for others to see, so it waits for you." });
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
