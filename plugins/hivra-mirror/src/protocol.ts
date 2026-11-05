// WP-85. The session variable Hivra sets on chats it starts, and the loopback discovery rules.

export const SESSION_ENV = "MONOCODE_HARNESS_PARENT";

export type Discover =
  | { mirror: true; host: "127.0.0.1"; port: number }
  | { mirror: false; retry: true; reason: string };

/** A non-empty Hivra parent variable means Hivra started this session, so the plugin stays off. */
export function shouldMirror(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[SESSION_ENV];
  return typeof value !== "string" || value.trim() === "";
}

export function hivraStarted(
  env: Readonly<Record<string, string | undefined>>,
  ancestors: readonly number[],
  hivraPid: number | null,
): boolean {
  if (!shouldMirror(env)) return true;
  return hivraPid != null && Number.isInteger(hivraPid) && hivraPid > 0 && ancestors.includes(hivraPid);
}

function pidOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * A missing file, a dead pid, a missing port, or a host that is not loopback is not a final failure.
 * The next hook tries again. The host we connect to is always 127.0.0.1, whatever the file says.
 */
export function discover(input: { running: unknown; alive: boolean }): Discover {
  if (!input.running || typeof input.running !== "object" || Array.isArray(input.running)) {
    return { mirror: false, retry: true, reason: "no running copy" };
  }
  const row = input.running as Record<string, unknown>;
  const pid = pidOf(row.pid);
  if (!input.alive || pid == null) return { mirror: false, retry: true, reason: "not running" };
  const port = row.mirrorPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { mirror: false, retry: true, reason: "no port" };
  }
  const host = row.mirrorHost;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    return { mirror: false, retry: true, reason: "not this Mac" };
  }
  return { mirror: true, host: "127.0.0.1", port };
}

export function hivraPid(running: unknown): number | null {
  if (!running || typeof running !== "object" || Array.isArray(running)) return null;
  return pidOf((running as { pid?: unknown }).pid);
}
