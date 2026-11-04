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

/**
 * A prompt that carries the contract. Builders use this, not `FIRST_MATE_CONTRACT`, so the Settings switch
 * leaves the plain-English line out. A prompt that already includes the contract is not given a second copy.
 */
export function withFirstMateContract(prompt: string): string {
  const contract = contractForAgents();
  const body = prompt.replace(/\r\n/g, "\n").trim();
  if (!body) return contract;
  if (!body.includes("# The first mate contract")) return `${body}\n\n${contract}`;
  if (plainEnglishEndings()) return body;
  return body
    .split("\n")
    .filter((line) => !line.includes(PLAIN_ENGLISH_RULE))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
