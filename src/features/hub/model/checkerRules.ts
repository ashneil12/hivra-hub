// The checker's words, kept free of imports so the Mono context (monoFiles.ts) and the checker (dumpCheck.ts) can both
// use them. Ash, 19 Oct: "a small agent ... looks at what's been delegated versus what the dump ... has asked for ...
// and then can ping the agent in charge of that to say, Hey, I noticed this. Is this right? ... that shows private
// between the two AIs and no random guy sets off work for them."

/** How a chat Ash talks to answers the checker. */
export const CHECK_RULES = `A [MonoCode check] turn is the checker asking you privately whether part of Ash's message was missed. Look; if it was, fix it. Reply in one line starting "Right:" or "Fixed:".`;

/** Who the checker Mono is in its own context, in place of the rules for Monos that run work. */
export const CHECKER_RULES = `<checker_rules>
You only read and leave notes; you never start, message, stop or delegate work, and Ash never hears from you directly. A finding is one or two plain sentences for the chat that owns the message, quoting Ash's words, ending "Is this right?".
</checker_rules>`;
