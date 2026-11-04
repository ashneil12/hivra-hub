// WP-23: `/council` from a first mate's chat. It is a built-in command, like /plan, so the line never reaches the model.
import type { BuiltinSkill } from "../../skills/model/skills";

export const COUNCIL_COMMAND: BuiltinSkill = {
  kind: "builtin",
  name: "council",
  invocation: "council",
  description: "Convene a council for a hard call.",
  scope: "builtin",
  source: "monocode",
};

/** A leading `/council`, and the question after it (which may be empty). Not a mention of the word mid-sentence. */
export function consumeCouncilCommand(text: string): { matched: boolean; question: string } {
  const match = /^\s*\/council\b(.*)$/i.exec(text);
  if (!match) return { matched: false, question: "" };
  return { matched: true, question: match[1].trim() };
}
