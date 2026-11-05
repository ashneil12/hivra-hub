// WP-84: the phase skill text the app puts in a run's brief. A missing file is not a document.

const raw = import.meta.glob("../../../../src-tauri/plugins/hivra-rpi/skills/*/SKILL.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const byName = new Map<string, string>();
for (const [path, text] of Object.entries(raw)) {
  const parts = path.replace(/\\/g, "/").split("/");
  const name = parts[parts.length - 2];
  if (name && typeof text === "string") byName.set(name, text);
}

/** The skill file for this phase, or nothing when the name is not one of ours. */
export function skillBody(name: string): string | undefined {
  if (!/^[a-z0-9-]+$/.test(name)) return undefined;
  return byName.get(name);
}
