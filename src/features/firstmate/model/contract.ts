// Hivra WP-10: the role rules every first mate reads (the coding team and every Mono), from contract.md. The prompts
// that make a chat a first mate (WP-20, WP-21) include this text; code enforces what it can (README.md beside it).
import contractText from "../contract.md?raw";
import { PLAIN_ENGLISH_RULE, plainEnglishEndings } from "./plainEnglish";

/** The contract without its credit comment (that stays in the file). */
export const FIRST_MATE_CONTRACT: string = contractText.replace(/<!--[\s\S]*?-->\s*/g, "").trim();

/** What a first mate reads. The plain-English line is left out when that Settings switch is off. */
export function contractForAgents(): string {
  if (plainEnglishEndings()) return FIRST_MATE_CONTRACT;
  return FIRST_MATE_CONTRACT.split("\n")
    .filter((line) => !line.includes(PLAIN_ENGLISH_RULE))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
