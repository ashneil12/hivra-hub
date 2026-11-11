// WP-101 fix round: which MCP servers reached this chat through a plugin the person installed in Hivra. A server's
// name is not evidence (`plugin-` can be typed into any project's .mcp.json), so the decision path asks the app for
// the exact set of names it wired from installed plugins for this chat (`plugins_session_wiring`, the same call the
// Claude launch makes, so a server the person's own configs add is never in it).
//
// The set is read fresh every time a call is decided, so a plugin installed, updated or removed changes what is
// trusted from the next decision on. Any failure to read it trusts nothing: every MCP call then waits for the person.

import { pluginWiringFor } from "../../plugins/model/pluginSessions";

/** The server names Hivra wired from installed plugins for one chat, in the form Claude Code sees them. */
export type TrustedServers = ReadonlySet<string>;

/** Where the set comes from; the hook passes the app's reader, tests pass their own. */
export type WiredServersReader = (cwd: string, sessionId: string) => Promise<TrustedServers>;

export const NO_TRUSTED_SERVERS: TrustedServers = new Set();

/**
 * A server name as Claude Code reads it (WP-101 fix round 2, item D): every character outside letters, digits and
 * `_ -` becomes an underscore when it builds the tool id `mcp__<server>__<tool>`. A project's `.mcp.json` can call a
 * server `plugin-a.b-srv`, and the calls arrive as `plugin-a_b-srv`: the same name Hivra gives its own server. Both
 * sides are compared in this form, so the comparison is the one Claude Code makes.
 */
export function normaliseServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/gu, "_");
}

/** Whether a server is one Hivra wired, comparing the incoming name the way Claude Code does. */
export function serverTrusted(trusted: TrustedServers | null | undefined, server: unknown): boolean {
  if (!trusted || typeof server !== "string" || !server) return false;
  try {
    return trusted.has(normaliseServerName(server));
  } catch {
    return false;
  }
}

/**
 * The names in a wiring answer, normalised, minus any that a server in the person's own configs also normalises to.
 * Such a server is one Claude Code would merge with Hivra's, so a call under that name could come from either: it
 * waits. Anything but an object of entries reads as none, and so does an answer that doesn't carry the configured
 * names, since then the clash can't be ruled out.
 */
export function trustedFromWiring(wiring: unknown): TrustedServers {
  if (!wiring || typeof wiring !== "object" || Array.isArray(wiring)) return NO_TRUSTED_SERVERS;
  const servers = (wiring as { claudeMcpServers?: unknown }).claudeMcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return NO_TRUSTED_SERVERS;
  // The app names every server the person's own configs use, in the same form. Without that list a name clash can't
  // be ruled out, so nothing is trusted: an older app, a failed read or a shape this file doesn't know all trust none.
  const configured = (wiring as { namesInUse?: unknown }).namesInUse;
  if (!Array.isArray(configured)) return NO_TRUSTED_SERVERS;
  const theirs = new Set<string>();
  for (const name of configured) if (typeof name === "string" && name) theirs.add(normaliseServerName(name));
  const names: string[] = [];
  for (const name of Object.keys(servers)) {
    if (!name || name === "__proto__") continue;
    const normalised = normaliseServerName(name);
    if (!theirs.has(normalised)) names.push(normalised);
  }
  return names.length ? new Set(names) : NO_TRUSTED_SERVERS;
}

/** A reader over any wiring source: what `appWiredServers` is, with the app's call swapped out in tests. */
export function wiredServersWith(read: (cwd: string, sessionId: string) => Promise<unknown>): WiredServersReader {
  return async (cwd, sessionId) => {
    if (!cwd) return NO_TRUSTED_SERVERS;
    try {
      return trustedFromWiring(await read(cwd, sessionId));
    } catch {
      return NO_TRUSTED_SERVERS;
    }
  };
}

/**
 * The app's reader: the same wiring a Claude launch gets for this chat. A folder on another machine, an app that
 * isn't running, or a wiring that fails all give none.
 */
export const appWiredServers: WiredServersReader = wiredServersWith((cwd, sessionId) => pluginWiringFor(cwd, sessionId));
