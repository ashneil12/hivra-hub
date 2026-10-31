import { isStatusQuestion } from "../../monos/model/statusReply";

/** "wat happened to the stuff i dumped", "where are we", "hows it going": a question about how things stand. */
export function asksHowThingsStand(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 200 || t.startsWith("[MonoCode")) return false;
  return isStatusQuestion(t) || /\bw(?:h)?at\s+(?:happened|happend)\b|\bwhere\s+(?:are|r)\s+we\b|\bwhat'?s\s+(?:left|open|done)\b/i.test(t);
}
