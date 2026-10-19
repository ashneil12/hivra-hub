// @vitest-environment happy-dom
// Connectors on the webview side: the rules a Mono's session is given connectors by (the same as Rust's, which decides
// again at launch), the MCP config a session gets, and the credential scan: a pasted secret goes to Rust once and is
// never in browser storage, the view, a session's arguments or the console.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "ghp_SENTINEL_0123456789abcdef";
const HIVRA = "/Users/ash/Projects/hivra";
const NIBBII = "/Users/ash/Projects/nibbii";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => vi.restoreAllMocks());

type View = import("./hubConnectors").ConnectorsView;

/** A stand-in for the Rust commands: logins in a "Keychain" map, everything else in the view (no secrets). */
function fakeRust() {
  const keychain = new Map<string, string>();
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const view: View = {
    settings: { composio: false, googleClient: false, connectors: {}, monos: {} },
    launcher: "/Applications/MonoCode Hub.app/Contents/MacOS/monocode",
    subcommand: "connector-run",
    kind: "dev",
  };
  const backend = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    const id = args?.id as string;
    switch (command) {
      case "connectors_state":
        break;
      case "connector_save_login":
        keychain.set(id, JSON.stringify(args?.fields));
        view.settings.connectors[id] = { signedIn: true, method: "token", allow: (args?.allow as string[] | null) ?? [] };
        break;
      case "connector_turn_on":
        view.settings.connectors[id] = { signedIn: true, method: "none", allow: (args?.allow as string[] | null) ?? [] };
        break;
      case "connector_set_allow":
        view.settings.connectors[id] = { ...view.settings.connectors[id], allow: args?.allow as string[] };
        break;
      case "connector_set_mono": {
        const choice = args?.choice as View["settings"]["monos"][string] | null;
        if (choice) view.settings.monos[args?.monoId as string] = choice;
        else delete view.settings.monos[args?.monoId as string];
        break;
      }
      case "connectors_set_composio":
        view.settings.composio = args?.on as boolean;
        break;
      case "connector_sign_out":
        keychain.delete(id);
        view.settings.connectors[id] = { allow: view.settings.connectors[id]?.allow };
        break;
      default:
        throw new Error(`unexpected ${command}`);
    }
    return structuredClone(view) as T;
  };
  return { keychain, calls, view, backend };
}

function roster(monos: { id: string; name: string; projects: string[]; sessionId?: string }[]) {
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify(monos.map((m) => ({ mascot: "robot", color: "hsl(0 0% 50%)", ...m }))),
  );
}

describe("which connectors a Mono gets", () => {
  it("follows the same rules as the launcher: every project must allow it, per-Mono choices only narrow", async () => {
    const c = await import("./hubConnectors");
    const github = c.catalogEntry("github")!;
    const settings = { composio: false, googleClient: false, monos: {}, connectors: { github: { signedIn: true, allow: [HIVRA] } } };
    expect(c.connectorDenied(settings, github, "m", [HIVRA])).toBeUndefined();
    expect(c.connectorDenied(settings, github, "m", [HIVRA, NIBBII])).toEqual({ why: "project-off", project: NIBBII });
    expect(c.connectorDenied(settings, github, "m", [])).toEqual({ why: "outside-off" });
    expect(c.connectorDenied({ ...settings, connectors: { github: { signedIn: true, allow: [c.OUTSIDE] } } }, github, "m", [])).toBeUndefined();
    expect(c.connectorDenied({ ...settings, connectors: { github: { signedIn: true, allow: [c.EVERYWHERE] } } }, github, "m", [HIVRA, NIBBII])).toBeUndefined();
    expect(c.connectorDenied({ ...settings, connectors: { github: { signedIn: false, allow: [c.EVERYWHERE] } } }, github, "m", [])).toEqual({ why: "not-signed-in" });
    expect(c.connectorDenied({ ...settings, connectors: { github: { signedIn: true, allow: [] } } }, github, "m", [HIVRA])).toEqual({ why: "project-off", project: HIVRA });
    const narrowed = { ...settings, monos: { m: { mode: "all" as const, except: ["github"] }, n: { mode: "only" as const, ids: ["github"] } } };
    expect(c.connectorDenied(narrowed, github, "m", [HIVRA])).toEqual({ why: "mono-off" });
    expect(c.connectorDenied(narrowed, github, "n", [HIVRA])).toBeUndefined();
    expect(c.connectorDenied(narrowed, github, "n", [NIBBII])).toEqual({ why: "project-off", project: NIBBII });
  });

  it("Composio needs its switch; main apps never go through it", async () => {
    const c = await import("./hubConnectors");
    const composio = c.catalogEntry("composio")!;
    const s = { composio: false, googleClient: false, monos: {}, connectors: { composio: { signedIn: true, allow: [c.EVERYWHERE] } } };
    expect(c.connectorDenied(s, composio, "m", [])).toEqual({ why: "needs-composio" });
    expect(c.connectorDenied({ ...s, composio: true }, composio, "m", [])).toBeUndefined();
    expect(c.directEntries().some((e) => e.composio)).toBe(false);
    expect(c.directEntries().length).toBeGreaterThanOrEqual(25);
    const connectors = await import("./connectors");
    expect(connectors.hasDirectConnector({ id: "x", name: "Example: Gmail", projectId: "p", signedIn: false })).toBe(true);
    expect(connectors.hasDirectConnector({ id: "y", name: "Pipedrive", projectId: "p", signedIn: false })).toBe(false);
  });

  it("toggling one Mono keeps its other choices", async () => {
    const c = await import("./hubConnectors");
    expect(c.toggledChoice(undefined, "github", false)).toEqual({ mode: "all", except: ["github"] });
    expect(c.toggledChoice({ mode: "all", except: ["github"] }, "github", true)).toBeNull();
    expect(c.toggledChoice({ mode: "only", ids: ["slack"] }, "github", true)).toEqual({ mode: "only", ids: ["slack", "github"] });
    expect(c.toggledChoice({ mode: "only", ids: ["slack"] }, "slack", false)).toEqual({ mode: "only", ids: [] });
  });
});

describe("a Mono's session", () => {
  it("gets only its allowed connectors, pointing at the launcher with its id and projects, and no login", async () => {
    const rust = fakeRust();
    roster([
      { id: "maya", name: "Maya", projects: [HIVRA], sessionId: "s-maya" },
      { id: "both", name: "Both", projects: [HIVRA, NIBBII], sessionId: "s-both" },
      { id: "cos", name: "Chief of Staff", projects: [], sessionId: "s-cos" },
    ]);
    const c = await import("./hubConnectors");
    c.setConnectorsBackend(rust.backend);
    await c.loadConnectors();
    expect(c.connectorArgsForSession("s-maya")).toEqual([]);
    await c.saveConnectorLogin("github", { token: SECRET }, [HIVRA]);
    await c.turnOnConnector("context7", [c.EVERYWHERE]);

    const args = c.connectorArgsForSession("s-maya");
    expect(args[0]).toBe("--mcp-config");
    const config = JSON.parse(args[1]) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(Object.keys(config.mcpServers).sort()).toEqual(["context7", "github"]);
    expect(config.mcpServers.github).toEqual({
      command: rust.view.launcher,
      args: ["connector-run", "github", "--mono", "maya", "--project", HIVRA],
    });
    // In Hivra and Nibbii: GitHub is off in Nibbii, so only what both allow.
    const both = JSON.parse(c.connectorArgsForSession("s-both")[1]) as { mcpServers: object };
    expect(Object.keys(both.mcpServers)).toEqual(["context7"]);
    // Outside any project: only what is allowed outside projects.
    const cos = JSON.parse(c.connectorArgsForSession("s-cos")[1]) as { mcpServers: object };
    expect(Object.keys(cos.mcpServers)).toEqual(["context7"]);
    // Not a Mono's conversation: nothing.
    expect(c.connectorArgsForSession("some-other-session")).toEqual([]);
    // Maya turned off GitHub.
    await c.setMonoConnectors("maya", c.toggledChoice(undefined, "github", false));
    expect(Object.keys((JSON.parse(c.connectorArgsForSession("s-maya")[1]) as { mcpServers: object }).mcpServers)).toEqual(["context7"]);
  });

  it("merges with the Lead's ash-os entry into one --mcp-config", async () => {
    const seam = await import("../../../integrations/harness/providers/claude/claudeExtraArgs");
    const lead = ["--mcp-config", JSON.stringify({ mcpServers: { "ash-os": { command: "py" } } })];
    const conn = ["--mcp-config", JSON.stringify({ mcpServers: { github: { command: "/app", args: ["connector-run", "github"] } } })];
    seam.setClaudeExtraArgs(() => lead);
    expect(seam.claudeExtraArgs("s")).toEqual(lead);
    seam.setClaudeExtraArgs(() => conn, "connectors");
    const merged = seam.claudeExtraArgs("s");
    expect(merged.filter((a) => a === "--mcp-config")).toHaveLength(1);
    expect(Object.keys((JSON.parse(merged[1]) as { mcpServers: object }).mcpServers).sort()).toEqual(["ash-os", "github"]);
    seam.setClaudeExtraArgs(() => { throw new Error("broken provider"); }, "broken");
    expect(seam.claudeExtraArgs("s")).toEqual(merged);
    expect(seam.mergeMcpConfigs(["--mcp-config", "/tmp/file.json", "--x"])).toEqual(["--mcp-config", "/tmp/file.json", "--x"]);
    seam.setClaudeExtraArgs(undefined);
    seam.setClaudeExtraArgs(undefined, "connectors");
    seam.setClaudeExtraArgs(undefined, "broken");
  });
});

describe("reading the state", () => {
  it("a backend without connectors (an older build, a stand-in) is an error once, never a loop of reads", async () => {
    const c = await import("./hubConnectors");
    const backend = vi.fn(async () => undefined as never);
    c.setConnectorsBackend(backend);
    await c.loadConnectors();
    expect(c.connectorsView()).toBeNull();
    expect(c.connectorsLoadError()).toMatch(/doesn't have connectors/);
    expect(backend).toHaveBeenCalledTimes(1);
    await expect(c.setComposioOn(true)).rejects.toThrow(/doesn't have connectors/);
  });
});

describe("credential scan", () => {
  it("a pasted secret reaches the Rust command once and is nowhere else on the webview side", async () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const rust = fakeRust();
    roster([{ id: "maya", name: "Maya", projects: [HIVRA], sessionId: "s-maya" }]);
    const c = await import("./hubConnectors");
    c.setConnectorsBackend(rust.backend);
    const view = await c.saveConnectorLogin("github", { token: SECRET }, [HIVRA]);

    // Exactly one call carried it, and it was the login command.
    const carrying = rust.calls.filter((call) => JSON.stringify(call.args ?? {}).includes(SECRET));
    expect(carrying.map((call) => call.command)).toEqual(["connector_save_login"]);
    // Not in the view, browser storage, the session's arguments, or anything logged.
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(JSON.stringify(c.connectorsView())).not.toContain(SECRET);
    const storage = Object.keys(localStorage).map((k) => localStorage.getItem(k)).join("\n");
    expect(storage).not.toContain(SECRET);
    const args = c.connectorArgsForSession("s-maya");
    expect(args.length).toBe(2);
    expect(args.join(" ")).not.toContain(SECRET);
    for (const spy of [log, warn, error]) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    // Signing out removes it from the "Keychain" and the session stops getting the connector.
    await c.signOutConnector("github");
    expect(rust.keychain.size).toBe(0);
    expect(c.connectorArgsForSession("s-maya")).toEqual([]);
  });

  it("the catalog never carries a literal secret and every local server gets its login by environment only", async () => {
    const raw = await import("./connectorCatalog.json");
    for (const entry of raw.connectors) {
      const launch = entry.launch as { kind: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string> };
      for (const arg of launch.args ?? []) expect(arg).not.toMatch(/\{[a-z_]+\}/);
      for (const value of [...Object.values(launch.env ?? {}), ...Object.values(launch.headers ?? {})])
        expect(value.replace(/\{[a-z_]+\}/g, "")).not.toMatch(/[A-Za-z0-9_-]{24,}/);
    }
  });
});
