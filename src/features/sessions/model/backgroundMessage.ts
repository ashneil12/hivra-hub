/** Old provider transcripts may lack the internal flag on these generated messages. */
export function isBackgroundMessage(text: string): boolean {
  return (
    /^\s*<system-notice(?:\s|>)/i.test(text) ||
    /^\s*Continue from where you left off\.?\s*$/i.test(text)
  );
}

/** A transport envelope saying "completed" is not evidence that its command succeeded. */
export function backgroundResultSummary(text: string): string {
  if (/timed out/i.test(text))
    return "A background command timed out. Its work is not verified.";
  if (/already open|error:|\bfailed\b|\binterrupted\b/i.test(text))
    return "A background command could not finish. Its work is not verified.";
  return "A background result arrived. The agent is checking it.";
}
