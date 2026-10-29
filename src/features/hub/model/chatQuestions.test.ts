// A chat's pending question: read from a live AskUserQuestion or a "Needs Ash:" line, with the agent's pick, and the
// answers "Take the pick" and a reply send. Pure: no app, no store.
import { describe, expect, it } from "vitest";
import { CUSTOM_OPTION_ID, type UserQuestionPrompt } from "../../sessions/model/userQuestion";
import {
  chatQuestion,
  gateQuestion,
  lastTurnText,
  looksRedLine,
  oneLine,
  parseNeedsAsh,
  pickMessage,
  pickReply,
  plainOptionLabel,
  wordsMessage,
  wordsReply,
} from "./chatQuestions";

const prompt = (over: Partial<UserQuestionPrompt> = {}): UserQuestionPrompt => ({
  requestId: 7,
  title: "Boss order",
  questions: [
    {
      id: "Which boss comes first?",
      header: "Boss order",
      prompt: "Which boss comes first?",
      multiSelect: false,
      allowCustom: true,
      options: [
        { id: "Shield (Recommended)", label: "Shield (Recommended)", description: "Teaches blocking before the flier" },
        { id: "Flier", label: "Flier" },
      ],
    },
  ],
  ...over,
});

describe("a live AskUserQuestion", () => {
  it("is one line with the option the agent marked (Recommended) as its pick", () => {
    const q = chatQuestion({ busy: true, pendingQuestion: prompt(), blocks: [] });
    expect(q).toEqual({ source: "ask", requestId: 7, question: "Which boss comes first?", more: 0, pick: "Shield", redLine: false, options: ["Shield", "Flier"] });
    expect(plainOptionLabel("Shield (Recommended)")).toBe("Shield");
  });

  it("Take the pick answers the tool with every recommended option; no pick when one question has none", () => {
    expect(pickReply(prompt())).toEqual({ kind: "answered", answers: { "Which boss comes first?": ["Shield (Recommended)"] } });
    const two = prompt({
      questions: [
        ...prompt().questions,
        { id: "Timer?", prompt: "Keep the timer?", multiSelect: false, allowCustom: true, options: [{ id: "Yes", label: "Yes" }, { id: "No", label: "No" }] },
      ],
    });
    expect(pickReply(two)).toBeUndefined();
    const q = chatQuestion({ pendingQuestion: two, blocks: [] })!;
    expect(q.more).toBe(1);
    expect(q.pick).toBeUndefined();
  });

  it("several questions with picks read as one line of picks in order", () => {
    const two = prompt({
      questions: [
        ...prompt().questions,
        { id: "Timer?", prompt: "Keep the timer?", multiSelect: false, allowCustom: true, options: [{ id: "Yes", label: "Yes (recommended)" }, { id: "No", label: "No" }] },
      ],
    });
    expect(chatQuestion({ pendingQuestion: two, blocks: [] })!.pick).toBe("Shield; Yes");
    expect(pickReply(two)).toEqual({ kind: "answered", answers: { "Which boss comes first?": ["Shield (Recommended)"], "Timer?": ["Yes"] } });
  });

  it("Ash's words answer every question that takes words", () => {
    expect(wordsReply(prompt(), "  Flier, but slower  ")).toEqual({
      kind: "answered",
      answers: { "Which boss comes first?": [CUSTOM_OPTION_ID] },
      custom: { "Which boss comes first?": "Flier, but slower" },
    });
    const closed = prompt({ questions: [{ ...prompt().questions[0], allowCustom: false }] });
    expect(wordsReply(closed, "Flier")).toBeUndefined();
    expect(wordsReply(prompt(), "   ")).toBeUndefined();
  });

  it("is a red line when the words touch Ash's red list, or the agent's header says so", () => {
    const money = prompt({ questions: [{ ...prompt().questions[0], prompt: "Refund the three customers who were double charged?" }] });
    expect(chatQuestion({ pendingQuestion: money, blocks: [] })!.redLine).toBe(true);
    const flagged = prompt({ questions: [{ ...prompt().questions[0], header: "Red line" }] });
    expect(chatQuestion({ pendingQuestion: flagged, blocks: [] })!.redLine).toBe(true);
  });

  it("reads the options' descriptions and the prompt's title for red lines too", () => {
    const plain = prompt().questions[0];
    const described = prompt({
      questions: [{ ...plain, prompt: "Which cleanup?", header: "Cleanup", options: [{ id: "b", label: "Option B (Recommended)", description: "Drop the users table and start fresh" }, { id: "a", label: "Option A" }] }],
    });
    expect(chatQuestion({ pendingQuestion: described, blocks: [] })!.redLine).toBe(true);
    const titled = prompt({ title: "Refund the double charge", questions: [{ ...plain, prompt: "Go ahead?", header: "Go", options: [{ id: "y", label: "Yes (Recommended)" }] }] });
    expect(chatQuestion({ pendingQuestion: titled, blocks: [] })!.redLine).toBe(true);
    expect(chatQuestion({ pendingQuestion: prompt(), blocks: [] })!.redLine).toBe(false);
  });
});

describe("a 'Needs Ash:' line", () => {
  it("is read from the agent's last turn with its 'My pick:' line", () => {
    const text = "Done with the parser.\n\n**Needs Ash:** Ship the new parser behind a flag, or replace the old one?\nMy pick: Behind a flag for a week.";
    expect(parseNeedsAsh(text)).toEqual({ question: "Ship the new parser behind a flag, or replace the old one?", pick: "Behind a flag for a week.", redLine: false });
  });

  it("the last one counts, a red-line flag is kept, and no pick is fine", () => {
    const text = "Needs Ash: old question\nMy pick: old\n\n> Needs Ash (red line): Email the waitlist about the delay?";
    expect(parseNeedsAsh(text)).toEqual({ question: "Email the waitlist about the delay?", redLine: true });
    expect(parseNeedsAsh("All done, nothing needs you.")).toBeNull();
  });

  it("a finished message waits, even while its turn runs (r75); Ash's reply ends it", () => {
    const asked = [
      { role: "user" as const, text: "fix the parser" },
      { role: "assistant" as const, text: "Needs Ash: Keep the old flag name?\nMy pick: Keep it." },
    ];
    expect(chatQuestion({ busy: false, blocks: asked })).toEqual({ source: "marker", question: "Keep the old flag name?", more: 0, pick: "Keep it.", redLine: false });
    expect(chatQuestion({ busy: true, blocks: asked })).toMatchObject({ question: "Keep the old flag name?", pick: "Keep it." });
    expect(chatQuestion({ busy: false, blocks: [...asked, { role: "user", text: "keep it" }] })).toBeNull();
  });

  it("a hidden report-back after the question is not Ash speaking", () => {
    const blocks = [
      { role: "user" as const, text: "go" },
      { role: "assistant" as const, text: "Needs Ash: Which branch?\nMy pick: main" },
      { role: "user" as const, text: "[MonoCode report] ...", monoSessionCompletion: { requestIds: [] } as never },
      { role: "assistant" as const, text: "The worker finished." },
    ];
    expect(lastTurnText(blocks)).toContain("Needs Ash: Which branch?");
  });
});

describe("the gate: only what needs Ash reaches Needs you (D3)", () => {
  const marker = (question: string, pick?: string, over: Partial<{ redLine: boolean; flag: string }> = {}) => ({
    source: "marker" as const,
    question,
    redLine: false,
    ...(pick ? { pick } : {}),
    ...over,
  });

  it("lets a choice, an approval and a red line through when each carries a recommendation", () => {
    expect(gateQuestion(marker("Keep the old page?", "Archive it."))).toMatchObject({ admit: true, kind: "choice" });
    expect(gateQuestion(marker("May I merge the parser branch?", "Yes, merge it."))).toMatchObject({ admit: true, kind: "approval" });
    expect(gateQuestion(marker("Email the waitlist about the delay?", "Send it Friday.", { redLine: true }))).toMatchObject({ admit: true, kind: "red line" });
    expect(gateQuestion(chatQuestion({ busy: true, pendingQuestion: prompt(), blocks: [] })!)).toMatchObject({ admit: true, kind: "choice" });
  });

  it("holds a plain progress update with a plain reason", () => {
    const held = gateQuestion(marker("Working on the docs; next I'll run the checks."));
    expect(held.admit).toBe(false);
    expect(held.reason).toMatch(/progress update/);
    expect(held.reason).toMatch(/stays in the chat/);
  });

  it("refuses an approval with no recommendation, and says why", () => {
    const held = gateQuestion(marker("May I restart the staging server?"));
    expect(held.admit).toBe(false);
    expect(held.reason).toMatch(/no recommendation/);
    expect(held.reason).toMatch(/stays in the chat/);
  });

  it("holds a live question when no option is marked as its recommendation", () => {
    const noPick = prompt({
      questions: [{ ...prompt().questions[0], options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] }],
    });
    const q = chatQuestion({ pendingQuestion: noPick, blocks: [] })!;
    expect(q.pick).toBeUndefined();
    const held = gateQuestion(q);
    expect(held.admit).toBe(false);
    expect(held.reason).toMatch(/no recommendation|none is marked as its recommendation/);
  });

  it("lets through an errand only Ash can run, where the errand is the recommendation", () => {
    expect(gateQuestion(marker("Log in to Vercel?", undefined, { flag: "sign in" }))).toMatchObject({ admit: true, kind: "action" });
    expect(gateQuestion(marker("Enter the one-time code.", undefined, { flag: "enter a code" }))).toMatchObject({ admit: true, kind: "action" });
  });

  it("holds a red line with no recommendation", () => {
    const held = gateQuestion(marker("Ship to production tonight?", undefined, { redLine: true }));
    expect(held.admit).toBe(false);
    expect(held.reason).toMatch(/red line/);
  });

  it("holds an answer that isn't an ask (a status with a pick on it)", () => {
    const held = gateQuestion(marker("The docs update is done.", "yes"));
    expect(held.admit).toBe(false);
    expect(held.reason).toMatch(/doesn't ask Ash/);
  });
});

describe("the words sent", () => {
  it("take the pick as Ash's go, naming the question when its turn has ended", () => {
    expect(pickMessage({ source: "marker", pick: "Behind a flag", question: "Ship it how?" })).toBe("Go with your pick: Behind a flag");
    expect(pickMessage({ source: "ask", pick: "Shield", question: "Which boss?" })).toBe('About your question "Which boss?": go with your pick, Shield');
    expect(wordsMessage({ source: "marker", question: "Q" }, " flier ")).toBe("flier");
    expect(wordsMessage({ source: "ask", question: "Which boss?" }, "flier")).toBe('About your question "Which boss?": flier');
  });

  it("one line is calm and cut at a word", () => {
    expect(oneLine("**Pick**   the\n\nboss")).toBe("Pick the boss");
    const long = oneLine("word ".repeat(80), 40);
    expect(long.length).toBeLessThanOrEqual(41);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("red lines", () => {
  it.each([
    "Promote the release to production?",
    "Delete the old user accounts?",
    "Email every customer about the price change?",
    "Withdraw the agent wallet balance?",
    "Force-push main to drop the bad commit?",
    "Restart all the VMs on the fleet?",
  ])("flags %s", (text) => expect(looksRedLine(text)).toBe(true));

  it.each(["Delete the old helper function?", "Which boss comes first?", "Name the test file parser.test.ts?", "Deploy to canary?"])(
    "lets %s through",
    (text) => expect(looksRedLine(text)).toBe(false),
  );
});
