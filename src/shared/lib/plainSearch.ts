/**
 * r83 (Critiquito, c02): a search step reads in plain words ("Search for BoardTally, Tally, title and count"), not the
 * raw pattern ("BoardTally|\\bTally\\b|title|count"). Since r92: "Searched for BoardTally, Tally, title, count". A plain one-word search keeps the usual "Find" row.
 */
export function plainSearchLabel(query: string): string | undefined {
  // Only a regex (alternation or escapes like \\b); a glob such as **/*.{json,md} is already readable as it is.
  if (!/\||\\[bwsdBWSD]/.test(query) || /\*\*|\//.test(query)) return undefined;
  const parts = [
    ...new Set(
      query
        .replace(/\\[bwsdBWSD]/g, " ")
        // r92 (c02 0176 foot, "Tally|from ['\"].*shared"): a character class and stray quotes are not words.
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/[()^$*+?[\]{}\\.'"`]/g, " ")
        .split("|")
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];
  if (!parts.length) return undefined;
  const shown = parts.length > 4 ? [...parts.slice(0, 2), `${parts[2]} and ${parts.length - 3} more`] : parts;
  // r92 (Critiquito a): past tense and a plain comma list, as the rows around it read ("Searched for monday, rollover, week").
  return `Searched for ${shown.join(", ")}`;
}

/**
 * r92 (Critiquito a, c; s19 d452): a search row a shell command made ("Find monday|rollover|week" from rg, "Find files"
 * from rg --files) reads in the same plain words as any other: "Searched for monday, rollover, week", "Search the
 * project's files". Anything else is returned as it was.
 */
export function plainFindRow(label: string): string {
  const match = /^Find\s+(.+)$/.exec(label);
  if (!match) return label;
  if (/^files$/i.test(match[1].trim())) return "Search the project's files";
  return plainSearchLabel(match[1].trim()) ?? label;
}
