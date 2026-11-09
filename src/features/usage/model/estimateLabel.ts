/** Shown beside every dollar figure. It is not the person's bill. */
export const ESTIMATE_LABEL = "estimated, not your bill";

/**
 * Attach the estimate label to a line that shows a dollar figure.
 * A line with no dollar is unchanged, and the label is not added twice.
 */
export function labelEstimate(line: string): string {
  if (typeof line !== "string" || !line.includes("$")) return line;
  if (line.includes(ESTIMATE_LABEL)) return line;
  return `${line} (${ESTIMATE_LABEL})`;
}
