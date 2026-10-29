import { describe, expect, it } from "vitest";
import { buildClaudeSpawnArgs } from "../providers/claude/claudeProtocol";
import { CREDENTIAL_BLOCK_MESSAGE, CREDENTIAL_DENY_RULES, credentialBlock } from "./credentialGuard";

const CWD = "/Users/ash/Projects/hivra";

describe("r65 #13: no agent reads a saved password, key or token", () => {
  it("blocks keychain commands, the exact Hivra one included", () => {
    for (const command of [
      'security find-generic-password -s "Stripe" -w',
      "security find-internet-password -a ash",
      "security dump-keychain -d login.keychain",
      "/usr/bin/security find-generic-password -l x",
      "echo hi && security find-certificate -a",
      "KEY=$(security find-generic-password -w -s x)",
    ])
      expect(credentialBlock({ tool: "Bash", command }, CWD), command).toBe(CREDENTIAL_BLOCK_MESSAGE);
  });

  it("blocks the agents' own sign-in files by command or by read", () => {
    expect(credentialBlock({ tool: "Bash", command: "cat ~/.claude/.credentials.json" }, CWD)).toBeDefined();
    expect(credentialBlock({ tool: "Read", paths: ["/Users/ash/.claude/.credentials.json"] }, CWD)).toBeDefined();
    expect(credentialBlock({ tool: "Read", paths: ["/Users/ash/.codex/auth.json"] }, CWD)).toBeDefined();
    expect(credentialBlock({ tool: "Bash", command: "cat $HOME/.aws/credentials" }, CWD)).toBeDefined();
    expect(credentialBlock({ tool: "Read", paths: ["/Users/ash/Library/Keychains/login.keychain-db"] }, CWD)).toBeDefined();
  });

  it("blocks a .env outside the project and allows the project's own", () => {
    expect(credentialBlock({ tool: "Bash", command: "cat ~/Projects/other/.env" }, CWD)).toBeDefined();
    expect(credentialBlock({ tool: "Read", paths: ["/Users/ash/.env"] }, CWD)).toBeDefined();
    expect(credentialBlock({ tool: "Bash", command: "cat ../other/.env.local" }, CWD)).toBeDefined();
    expect(credentialBlock({ tool: "Read", paths: [`${CWD}/.env`] }, CWD)).toBeUndefined();
    expect(credentialBlock({ tool: "Bash", command: "cat .env.example" }, CWD)).toBeUndefined();
    expect(credentialBlock({ tool: "Bash", command: `grep KEY ${CWD}/apps/web/.env.local` }, CWD)).toBeUndefined();
  });

  it("leaves ordinary work alone", () => {
    for (const command of ["npm test", "git status", "security-audit --help", "cat src/security.ts", "ls ~/.claude/skills"])
      expect(credentialBlock({ tool: "Bash", command }, CWD), command).toBeUndefined();
    expect(credentialBlock(undefined, CWD)).toBeUndefined();
  });

  it("tells the agent to ask Ash with a provide line instead of retrying", () => {
    expect(CREDENTIAL_BLOCK_MESSAGE).toContain("Needs Ash (provide):");
    expect(CREDENTIAL_BLOCK_MESSAGE).toMatch(/Don't retry/);
  });

  it("every Claude launch carries the deny rules, Full access and helpers included", () => {
    for (const input of [{ permissionMode: "bypassPermissions" as const }, { isolated: true }, {}]) {
      const args = buildClaudeSpawnArgs(input);
      const at = args.indexOf("--disallowedTools");
      expect(at).toBeGreaterThan(-1);
      const rules = args[at + 1].split(",");
      expect(rules).toEqual([...CREDENTIAL_DENY_RULES]);
      expect(rules).toContain("Bash(security find-generic-password:*)");
      expect(rules).toContain("Bash(security dump-keychain:*)");
      expect(rules).toContain("Read(~/.claude/.credentials.json)");
    }
  });
});
