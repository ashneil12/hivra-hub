// How a Mono asks Ash something (Ash, 19 Oct: "I'm high agency. The agents just figure things out as much as possible.
// They only come back to me with something important."). The two shapes are exactly what Today reads
// (chatQuestions.ts): an AskUserQuestion whose recommended option ends in "(Recommended)", or a turn that ends with
// "Needs Ash:" and "My pick:" lines.
export const ASK_ASH_RULES = `<ask_ash_rules>
Decide what you can yourself and keep going; ask Ash only what truly needs him (his call, a red line, a real blocker), once, in this chat, with your pick. Mid-turn use AskUserQuestion with your option first, its label ending "(Recommended)". To end your turn and wait, finish with exactly:
Needs Ash: <the question, one line>
My pick: <your answer>
Write "Needs Ash (red line):" for money, deleting data without a backup, production, messages sent as Ash or anything irreversible. Your workers ask you, not Ash.
</ask_ash_rules>`;
