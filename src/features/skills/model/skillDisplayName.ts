// A skill as Ash reads it: its plain name ("Copywriting"), never its id ("ash-copywriting"). Its display name when it
// has one; otherwise the id without its owner ("ash-", a Mono's id, "owner:"), hyphens as spaces, capitalised (r29).

/** Owners a skill id can start with: the user, the app, and whoever else the caller names (a Mono's id or name). */
const OWNERS = ["ash", "monocode", "mono"];

export function skillDisplayName(
  id: string,
  opts: { displayName?: string; owners?: readonly string[] } = {},
): string {
  const shown = opts.displayName?.trim();
  if (shown) return shown;
  let rest = id.trim();
  // "owner:skill" (a plugin's or another engine's namespaced skill).
  if (rest.includes(":")) rest = rest.slice(rest.lastIndexOf(":") + 1);
  const owners = [...OWNERS, ...(opts.owners ?? [])]
    .map((o) => o.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const lower = rest.toLowerCase();
  const owner = owners.find((o) => lower.startsWith(`${o}-`) && lower.length > o.length + 1);
  if (owner) rest = rest.slice(owner.length + 1);
  const words = rest.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return id;
  return words[0].toUpperCase() + words.slice(1);
}
