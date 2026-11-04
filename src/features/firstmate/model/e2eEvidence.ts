// WP-42. Paths from a worker's report that are proof under its `.e2e/` folder. Anything else is dropped.

/** `.e2e` paths a person can be shown. Absolute paths, `..`, and duplicates are left out. */
export function e2eEvidence(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const path = item.replace(/\\/g, "/").trim();
    if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path)) continue;
    const parts = path.split("/");
    if (parts.length < 2 || parts[0] !== ".e2e") continue;
    if (parts.some((part) => part.length === 0 || part === "." || part === "..")) continue;
    if (out.includes(path)) continue;
    out.push(path);
  }
  return out;
}
