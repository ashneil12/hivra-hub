// A dev copy never gets Ash's ash-os MCP entry (src-tauri/src/hub.rs `hub_ash_os_mcp` is null there), so its chats
// have no ash-os tools. A proof that needs them (a Lead answering the checker with ash_record) can opt in to a stand-in
// that talks only to the dev slot's own stub: start the dev copy with VITE_MONOCODE_DEV_ASH_OS set to its MCP entry as
// JSON (scripts/hub-stub-ash-os-mcp.mjs prints one). The daily app ignores it, and so does a dev copy without it.
import { isDevCopy } from "../../../app/model/appIdentity";
import type { AshOsServer } from "./hubLeads";

export function parseAshOsEntry(raw: unknown): AshOsServer | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.command !== "string" || !value.command) return null;
    const args = Array.isArray(value.args) ? value.args.filter((a): a is string => typeof a === "string") : [];
    const env =
      value.env && typeof value.env === "object" && !Array.isArray(value.env)
        ? Object.fromEntries(
            Object.entries(value.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
    return { command: value.command, args, env };
  } catch {
    return null;
  }
}

/** The stand-in's entry, in a dev copy that was started with one; otherwise null. */
export function devAshOsStandIn(): AshOsServer | null {
  if (!isDevCopy()) return null;
  return parseAshOsEntry(import.meta.env.VITE_MONOCODE_DEV_ASH_OS);
}
