/**
 * r83 (Critiquito, c02): a search step reads in plain words ("Search for BoardTally, Tally, title and count"), not the
 * raw pattern ("BoardTally|\\bTally\\b|title|count"). A plain one-word search keeps the usual "Find" row.
 */
export function plainSearchLabel(query: string): string | undefined {
  // Only a regex (alternation or escapes like \\b); a glob such as **/*.{json,md} is already readable as it is.
  if (!/\||\\[bwsdBWSD]/.test(query) || /\*\*|\//.test(query)) return undefined;
  const parts = [
    ...new Set(
      query
        .replace(/\\[bwsdBWSD]/g, " ")
        .replace(/[()^$*+?[\]{}\\.]/g, " ")
        .split("|")
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];
  if (!parts.length) return undefined;
  const shown = parts.length > 4 ? [...parts.slice(0, 3), `${parts.length - 3} more`] : parts;
  const words = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return `Search for ${words}`;
}
