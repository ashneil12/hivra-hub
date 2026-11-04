// WP-23: the round prompts, copied from council-of-high-intelligence SKILL.md (MIT, Copyright (c) 2026 nyk).
// The licence is in ../personas/LICENSE. Slots in braces are filled by protocol.ts. The words are not rewritten.
// Source: https://github.com/0xnyk/council-of-high-intelligence

/** Round 1, the blind prompt. SKILL.md, "Prompt template" under STEP 2. */
export const BLIND_TEMPLATE = [
  "You are operating as a council member in a structured deliberation.",
  "{identity}",
  "",
  "The problem under deliberation:",
  "{problem}",
  "",
  "Here is how each member reframed the problem:",
  "{restatements}",
  "",
  "Reason via your designated method: {reasoning_method}. Do not imitate other members' methods — method diversity is the point (DMAD, arXiv:2410.12853).",
  "Produce your independent analysis using your Output Format (Standalone).",
  "Do NOT try to anticipate what other members will say.",
  "Limit: 400 words maximum.",
].join("\n");

/** Round 2, the anonymised cross-exam. SKILL.md, the prompt template under STEP 3. Batch B is omitted: this room has no second batch. */
export const CROSS_TEMPLATE = [
  "You are council-{name} in Round 2 of a structured deliberation.",
  "Read your agent definition at ~/.claude/agents/council-{name}.md.",
  "",
  "**Identity is masked in this round.** The Round 1 analyses below are labeled",
  "Member A, Member B, … — you do not know which colleague produced which. One",
  "of them is your own Round 1 output (anonymized along with the rest). Evaluate",
  "by argument quality, not by source. Do not try to guess identities and do not",
  "reference any council member by their real name in this round; use the labels.",
  "",
  "Here are the (anonymized) Round 1 analyses from all council members:",
  "",
  "{outputs}",
  "",
  "**Anti-conformity directive.** If your Round 1 position was correct, defend it.",
  "Do not update merely because peers disagree, because consensus is forming, or",
  "because a position is repeated by multiple members. Update only when presented",
  "with sound, validity-aligned reasoning that exposes a specific flaw in your",
  "earlier argument. Naming that flaw is required when you update; if you cannot",
  "name it, you should not update.",
  "",
  "Now respond using your Output Format (Council Round 2):",
  "1. Which member's position do you most disagree with, and why? Engage their specific claims. Refer to them as \"Member X\".",
  "2. Which member's insight strengthens your position? How? Refer to them as \"Member Y\".",
  "3. Restate your position in light of this exchange, noting any changes.",
  "4. Label your key claims: empirical | mechanistic | strategic | ethical | heuristic",
  "",
  "Limit: 300 words maximum. You MUST engage at least 2 other members by label.",
].join("\n");

/** Round 3, the stance line. SKILL.md, the final prompt under STEP 5. */
export const STANCE_TEMPLATE = [
  "Final round. State your position declaratively in 100 words or less.",
  "Socrates: you get exactly ONE question. Make it count. Then state your position.",
  "No new arguments — only crystallization of your stance.",
  "",
  "Then, on the LAST line, emit your structured stance EXACTLY in this format",
  "so the council can tally it:",
  "STANCE: <one short option label> | CONFIDENCE: high|med|low | DEALBREAKER: yes|no",
  "",
  "- STANCE must be a terse label for the option you back (e.g. \"monorepo\",",
  "  \"ship now\", \"do not ship\"). Use the SAME wording as peers where you agree —",
  "  matching labels are what make the tally countable. If you genuinely back no",
  "  option, write STANCE: abstain.",
  "- DEALBREAKER: yes means you consider the opposing option actively harmful, not",
  "  merely sub-optimal — surfaced in the Minority Report even if you're outvoted.",
].join("\n");

/** The chairman. SKILL.md, "Chairman prompt template" under STEP 7. */
export const CHAIRMAN_TEMPLATE = [
  "You are the Chairman of the Council of High Intelligence. You did not",
  "deliberate in this session — you are the synthesizer.",
  "",
  "The original problem under deliberation:",
  "{problem}",
  "",
  "The full deliberation transcript follows. Member names are now visible",
  "(Round 2 was anonymized for the members but the audit transcript restores",
  "real names for synthesis).",
  "",
  "Round 1 — Independent Analysis:",
  "{round1}",
  "",
  "Round 2 — Cross-Examination:",
  "{round2}",
  "",
  "Round 3 — Final Crystallization:",
  "{round3}",
  "",
  "Your job:",
  "- Weigh arguments by validity, not by repetition or seniority.",
  "- Surface genuine disagreement; do not invent positions no member held.",
  "- Lead with what the council does NOT know (Unresolved Questions).",
  "- Produce the Council Verdict using the template that follows. Do not",
  "  add, remove, or rename sections. Fill each section faithfully or write",
  '  "N/A — {reason}" if the section is genuinely empty in this session.',
].join("\n");
