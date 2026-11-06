// WP-101 fix round: which MCP servers reached this chat through a plugin the person installed in Hivra. A server's
// name is not evidence (`plugin-` can be typed into any project's .mcp.json), so the decision path asks the app for
// the exact set of names it wired from installed plugins for this chat (`plugins_session_wiring`, the same call the
// Claude launch makes, so a server the person's own configs add is never in it).
//
// The set is read fresh every time a call is decided, so a plugin installed, updated or removed changes what is
// trusted from the next decision on. Any failure to read it trusts nothing: every MCP call then waits for the person.

import { pluginWiringFor } from "../../plugins/model/pluginSessions";

/** The server names Hivra wired from installed plugins for one chat. */
export type TrustedServers = ReadonlySet<string>;

/** Where the set comes from; the hook passes the app's reader, tests pass their own. */
export type WiredServersReader = (cwd: string, sessionId: string) => Promise<TrustedServers>;

export const NO_TRUSTED_SERVERS: TrustedServers = new Set();

/** The names in a wiring answer. Anything but an object of entries reads as none. */
export function trustedFromWiring(wiring: unknown): TrustedServers {
  if (!wiring || typeof wiring !== "object" || Array.isArray(wiring)) return NO_TRUSTED_SERVERS;
  const servers = (wiring as { claudeMcpServers?: unknown }).claudeMcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return NO_TRUSTED_SERVERS;
  const names: string[] = [];
  for (const name of Object.keys(servers)) if (name && name !== "__proto__") names.push(name);
  return new Set(names);
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
