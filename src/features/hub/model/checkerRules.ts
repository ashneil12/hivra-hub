// The checker's words, kept free of imports so the Mono context (monoFiles.ts) and the checker (dumpCheck.ts) can both
// use them. Ash, 19 Oct: "a small agent ... looks at what's been delegated versus what the dump ... has asked for ...
// and then can ping the agent in charge of that to say, Hey, I noticed this. Is this right? ... that shows private
// between the two AIs and no random guy sets off work for them."

/** How a chat Ash talks to answers the checker: said in the check's own turn (dumpCheck.ts), never in a chat's note. */
export const CHECK_RULES = `Look; if it was missed, fix it. Reply in one line starting "Right:" or "Fixed:".`;

/** Who the checker Mono is, in its own note (monoFiles.ts). */
export const CHECKER_RULES = `You only read and leave notes; you never start, message, stop or delegate work, and Ash never hears from you directly.`;
