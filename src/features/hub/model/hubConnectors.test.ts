// @vitest-environment happy-dom
// Connectors on the webview side: the rules a Mono's session is given connectors by (the same as Rust's, which decides
// again at launch), the MCP config a session gets, and the credential scan: a pasted secret goes to Rust once and is
// never in browser storage, the view, a session's arguments or the console.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These load the hub's modules fresh per test (dynamic imports): slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

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

/** A chat's extra Claude Code arguments as the hub builds them: ONE --mcp-config (hubMcp.ts) with connectors inside. */
async function chatArgs(sessionId: string): Promise<string[]> {
  const { hubMcpArgs } = await import("./hubMcp");
  const { connectorServersForMono } = await import("./hubConnectors");
  const { monoForSession } = await import("../../monos/model/mono");
  return hubMcpArgs(
    sessionId,
    { ashOs: { command: "ash-os-server" }, cli: "/app/monocode", connectors: connectorServersForMono },
    { monoOf: monoForSession, habitRunMono: (id) => (id === "habit-run-maya" ? "maya" : undefined), isLead: () => false },
  );
}
type Servers = Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
function servers(args: string[]): Servers {
  expect(args.filter((a) => a === "--mcp-config")).toHaveLength(1);
  return (JSON.parse(args[args.indexOf("--mcp-config") + 1]) as { mcpServers: Servers }).mcpServers;
}

describe("a Mono's chat", () => {
  it("gets one --mcp-config: ash-os, the delegate tool and only its allowed connectors, with no login", async () => {
    const rust = fakeRust();
    roster([
      { id: "maya", name: "Maya", projects: [HIVRA], sessionId: "s-maya" },
      { id: "both", name: "Both", projects: [HIVRA, NIBBII], sessionId: "s-both" },
      { id: "cos", name: "Chief of Staff", projects: [], sessionId: "s-cos" },
    ]);
    const c = await import("./hubConnectors");
    c.setConnectorsBackend(rust.backend);
    await c.loadConnectors();
    expect(Object.keys(servers(await chatArgs("s-maya"))).sort()).toEqual(["ash-os", "monocode"]);
    await c.saveConnectorLogin("github", { token: SECRET }, [HIVRA]);
    await c.turnOnConnector("context7", [c.EVERYWHERE]);

    const maya = servers(await chatArgs("s-maya"));
    expect(Object.keys(maya).sort()).toEqual(["ash-os", "context7", "github", "monocode"]);
    expect(maya.github).toEqual({
      command: rust.view.launcher,
      args: ["connector-run", "github", "--mono", "maya", "--project", HIVRA],
    });
    expect(maya["ash-os"].env).toMatchObject({ ASH_MONO_ID: "maya", ASH_CHAT: "s-maya" });
    // Its habit runs work as Maya: her connectors, no delegate tool.
    expect(Object.keys(servers(await chatArgs("habit-run-maya"))).sort()).toEqual(["ash-os", "context7", "github"]);
    // In Hivra and Nibbii: GitHub is off in Nibbii, so only what both allow.
    expect(Object.keys(servers(await chatArgs("s-both"))).sort()).toEqual(["ash-os", "context7", "monocode"]);
    // Outside any project: only what is allowed outside projects.
    expect(Object.keys(servers(await chatArgs("s-cos"))).sort()).toEqual(["ash-os", "context7", "monocode"]);
    // A worker or a plain chat: no connectors.
    expect(Object.keys(servers(await chatArgs("app-s-maya-r1"))).sort()).toEqual(["ash-os"]);
    expect(Object.keys(servers(await chatArgs("some-other-chat"))).sort()).toEqual(["ash-os"]);
    // Maya turned off GitHub.
    await c.setMonoConnectors("maya", c.toggledChoice(undefined, "github", false));
    expect(Object.keys(servers(await chatArgs("s-maya"))).sort()).toEqual(["ash-os", "context7", "monocode"]);
  });

  it("a connector can never take the hub's own entry names", async () => {
    const { hubMcpArgs } = await import("./hubMcp");
    roster([{ id: "maya", name: "Maya", projects: [], sessionId: "s-maya" }]);
    const { monoForSession } = await import("../../monos/model/mono");
    const args = hubMcpArgs(
      "s-maya",
      { ashOs: { command: "ash-os-server" }, cli: "/app/monocode", connectors: () => ({ "ash-os": { command: "evil" }, monocode: { command: "evil" } }) },
      { monoOf: monoForSession, habitRunMono: () => undefined, isLead: () => false },
    );
    const s = servers(args);
    expect(s["ash-os"].command).toBe("ash-os-server");
    expect(s.monocode.command).toBe("/app/monocode");
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
    const args = await chatArgs("s-maya");
    expect(Object.keys(servers(args))).toContain("github");
    expect(args.join(" ")).not.toContain(SECRET);
    for (const spy of [log, warn, error]) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    // Signing out removes it from the "Keychain" and the session stops getting the connector.
    await c.signOutConnector("github");
    expect(rust.keychain.size).toBe(0);
    expect(Object.keys(servers(await chatArgs("s-maya")))).not.toContain("github");
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
