// Hivra WP-10: the role rules every first mate reads (the coding team and every Mono), from contract.md. The prompts
// that make a chat a first mate (WP-20, WP-21) include this text; code enforces what it can (README.md beside it).
import contractText from "../contract.md?raw";

/** The contract without its credit comment (that stays in the file). */
export const FIRST_MATE_CONTRACT: string = contractText.replace(/<!--[\s\S]*?-->\s*/g, "").trim();
