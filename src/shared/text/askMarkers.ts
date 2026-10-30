/**
 * r99 (Critiquito 1): the app reads "Needs Ash:" / "Needs the user:" and "My pick:" lines off a reply to build the ask
 * card (chatQuestions.ts parses the saved text, so the text itself stays as written). Where the reply renders, Ash
 * reads no markers and no third person about himself in his own chat: the label goes, the question and the pick stay,
 * spoken to him. Code fences are left alone.
 */
const NEEDS = /^(?<lead>[\s>*_\-•]*)needs\s+(?:ash|the\s+user|you)\s*(?:\([^)]*\))?\s*[*_]*\s*[:\-—]\s*[*_]*\s*(?<rest>.+)$/i;
const PICK = /^(?<lead>[\s>*_\-•]*)my\s+(?:pick|recommendation)\s*[*_]*\s*[:\-—]\s*[*_]*\s*(?<rest>.+)$/i;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/** "the user" / "Ash" / "Ash's" in a line spoken to Ash become "you" / "your". */
export function toSecondPerson(text: string): string {
  return text
    .replace(/\b(?:the user|Ash)['’]s\b/g, "your")
    .replace(/\b(?:the user|Ash)\b/g, "you")
    .replace(/^you\b/, "You");
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

export function withoutAskMarkers(text: string): string {
  if (!text || !/\b(?:needs|my\s+(?:pick|recommendation))\b/i.test(text)) return text;
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const needs = NEEDS.exec(line);
      if (needs?.groups) return `${needs.groups.lead}${toSecondPerson(needs.groups.rest!.replace(/^[*_]+|[*_]+$/g, "").trim())}`;
      const pick = PICK.exec(line);
      if (pick?.groups) return `${pick.groups.lead}I'd go with ${lowerFirst(toSecondPerson(pick.groups.rest!.replace(/^[*_]+|[*_]+$/g, "").trim()))}`;
      return line;
    })
    .join("\n");
}
