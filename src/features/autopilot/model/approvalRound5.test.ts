// WP-101 review round 5. H1: a colon in a folder name is a name, not a level (the climb through it is read as written).
// H2: a chat whose folder is home or shallower holds every search, and a walk that starts at a parent of a credential
// place. M1 (the "." probes) is in approvalParity.json. L1 and L2 are below.
import { describe, expect, it } from "vitest";
import { approvalVerdict } from "./decide";
import { credentialInPaths } from "./credentialPaths";
import { credentialBlock } from "../../../integrations/harness/core/credentialGuard";
import { editInside, safeCall } from "./safeApproval";

const FOLDER = "/Users/ash/proj";
const bash = (command: string) => ({ text: "", tool: { title: command, kind: "execute" }, approval: { call: { tool: "Bash", command, folderPinned: true } } }) as any;
const tool = (name: string, call: Record<string, unknown>) => ({ text: "", tool: { title: name, kind: "read" }, approval: { call: { tool: name, ...call } } }) as any;
const held = (block: any, folder = FOLDER) => expect(approvalVerdict(block, folder)).toMatchObject({ kind: "held" });
const allowed = (block: any, folder = FOLDER) => expect(approvalVerdict(block, folder)).toMatchObject({ kind: "allow" });

describe("H1: a colon in a folder name is a name", () => {
  it("holds a read that climbs through a colon folder into a login or config file", () => {
    for (const path of [
      "/Users/ash/proj/a:b/../../.claude/settings.json",
      "/Users/ash/proj/a:b/../../.zshrc",
      "/Users/ash/proj/a:b:c/../../../.zshrc",
      "/Users/ash/proj/a:b/../../.config/aichat/config.yaml",
      "C:\\Users\\ash\\proj\\a:b\\..\\..\\.claude\\settings.json",
    ]) {
      expect(credentialInPaths([path], FOLDER), path).not.toBeNull();
      held(tool("Read", { paths: [path] }));
    }
  });

  it("holds the same climb through NotebookRead, and a bash read of it", () => {
    held(tool("NotebookRead", { paths: ["/Users/ash/proj/a:b/../../.zshrc"] }));
    held(bash("cat /Users/ash/proj/a:b/../../.zshrc"));
    held(bash("cat /Users/ash/proj/a:b:c/../../../.zshrc"));
  });

  it("holds an edit that climbs through a colon folder, and a colon after the drive", () => {
    expect(editInside("a:b/../../.claude/settings.json", FOLDER)).not.toBeNull();
    expect(credentialInPaths(["/Users/ash/proj/x:y.txt"], FOLDER)).not.toBeNull();
    expect(credentialInPaths(["C:\\Users\\ash\\proj\\a:b\\..\\..\\.zshrc"], FOLDER)).not.toBeNull();
  });

  it("holds any Read path with a colon after the drive, even one that climbs nowhere", () => {
    held(tool("Read", { paths: [`${FOLDER}/a:b/keep.txt`] }));
  });
});

describe("H2: a chat folder at home or shallower holds every search", () => {
  const HOME = "/Users/ash";
  it("holds a bash search over Library from a home-folder chat", () => {
    held(bash("rg -a sk-ant- Library"), HOME);
    held(bash("rg --binary -o AKIA Library"), HOME);
    held(bash("rg -a -o sk-ant-api03 ."), HOME);
  });

  it("holds Grep and LS from a home-folder chat, with a path, the dot, or none", () => {
    held(tool("Grep", { paths: ["."] }), HOME);
    held(tool("Grep", { paths: ["Library"] }), HOME);
    held(tool("Grep", { paths: undefined }), HOME);
    held(tool("LS", { paths: undefined }), HOME);
  });

  it("holds a walk that starts at a parent of a credential place, from a deep folder too", () => {
    held(bash("rg token Library"));
    held(tool("Grep", { paths: [`${FOLDER}/../../Library`] }));
    held(tool("Grep", { paths: ["/Library"] }));
    held(tool("Grep", { paths: ["/etc"] }));
    held(tool("Grep", { paths: ["/"] }));
  });

  it("still allows a search in a deep chat folder that names no secret", () => {
    allowed(bash("rg -n 'foo' src"), FOLDER);
    allowed(tool("Grep", { paths: [`${FOLDER}/src`] }), FOLDER);
  });
});

describe("M1 (approval side): dot segments are dropped before a place is read", () => {
  it("holds a read through a dot segment into a place", () => {
    held(bash("cat etc/./shadow"));
    held(bash("cat Library/./Keychains/login.keychain-db"));
  });
});

describe("L2 (approval side): MCP hosts in every form", () => {
  const SERVER = "plugin-agent_plugins-notion";
  const name = `mcp__${SERVER}__get_status`;
  const wired = new Set([SERVER]);
  it("holds IPv6, octal, and double-encoded forms", () => {
    for (const value of ["::1", "[::1]", "017700000001", "%252e%252e%252f"]) {
      expect(safeCall({ tool: name, args: [value] }, FOLDER, wired), value).not.toBeNull();
    }
  });
});

describe("L1: the guard's own source is held for an edit under any folder", () => {
  it("holds the autopilot hook, the credential guard, the Rust timer check and the Claude protocol", () => {
    for (const path of [
      "src/features/autopilot/hooks/useAutopilot.ts",
      "src/integrations/harness/core/credentialGuard.ts",
      "src-tauri/src/watcher/safe_cmd.rs",
      "src/integrations/harness/providers/claude/claudeProtocol.ts",
    ]) {
      expect(editInside(path, FOLDER), path).not.toBeNull();
    }
  });

  it("holds the shared security folder from a chat that sits inside src/shared", () => {
    expect(editInside("security/approvalParity.json", "/Users/ash/proj/src/shared")).not.toBeNull();
  });
});

describe("credential guard: home spellings", () => {
  it("holds a login reached through a colon folder in the command text", () => {
    expect(credentialBlock({ command: "cat /Users/ash/proj/a:b/../../.ssh/id_rsa" })).toBeDefined();
    held(bash("cat /Users/ash/proj/a:b/../../.zshrc"));
  });
});
