// WP-182: slash commands that live in an installed plugin's hivra/commands folder.
import { invoke } from "@tauri-apps/api/core";

export type PluginCommand = {
  name: string;
  description: string;
  file: string;
};

function commandFrom(value: unknown): PluginCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string" || !row.name) return undefined;
  if (typeof row.description !== "string" || typeof row.file !== "string") return undefined;
  return { name: row.name, description: row.description, file: row.file };
}

/** Commands from plugins enabled for this folder. Anything unreadable is an empty list. */
export async function listPluginCommands(cwd: string): Promise<PluginCommand[]> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return [];
  try {
    const rows = await invoke<unknown>("list_plugin_commands", { cwd });
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      const command = commandFrom(row);
      return command ? [command] : [];
    });
  } catch {
    return [];
  }
}
