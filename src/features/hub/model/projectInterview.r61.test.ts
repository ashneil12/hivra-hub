// PM's blind G2 (28 Oct): Chief of Staff said "I'll check whether anything already exists under that name, then I'll
// ask you the one thing that decides the setup", then "I'll confirm no folder is already sitting under that name, then
// I'll put the setup card up", and the chat sat idle: the turn is text only, so nothing ever ran after those replies.
import { beforeEach, describe, expect, it, vi } from "vitest";

const prompts: string[] = [];
let replies: string[] = [];
vi.mock("../../../integrations/harness", () => ({
  canRunHarnessTextPrompt: () => true,
  runHarnessTextPrompt: async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    return replies.shift() ?? "";
  },
}));
vi.mock("../../../platform/tauri/fs", async (importOriginal) => ({ ...(await importOriginal<object>()), homeDir: async () => "/Users/ash" }));
vi.mock("../../monos/model/mono", async (importOriginal) => ({ ...(await importOriginal<object>()), findMono: () => undefined }));

const { askChiefOfStaff, interviewNote } = await import("./projectInterview");

const STALL = "A maths app for your kids, ages 6 to 10, and nothing built yet. I'll confirm no folder is already sitting under that name, then I'll put the setup card up.";
const CARD = 'Here it is.\n```project\n{"name":"kids maths","oneLine":"A maths app for kids 6 to 10","template":"product-saas","code":"new","addon":false}\n```';

beforeEach(() => {
  prompts.length = 0;
  replies = [];
});

describe("Every interview turn leaves Ash something to answer (r61)", () => {
  it("a reply that only promises to check something is asked again, and Ash gets the card instead of silence", async () => {
    replies = [STALL, CARD];
    const reply = await askChiefOfStaff("kids maths", [{ from: "ash", text: "its a maths app for my kids, like 6 to 10 yr olds. nothing exists yet" }]);
    expect(reply.proposal?.template).toBe("product-saas");
    expect(prompts).toHaveLength(2);
    // The second turn sees what it said and that Ash is waiting on it.
    expect(prompts[1]).toContain("I'll confirm no folder is already sitting under that name");
    expect(prompts[1]).toMatch(/waiting/);
  });

  it("a stalled reply asked again can come back as a question", async () => {
    replies = ["Kids maths is named. I'll check whether anything already exists under that name, then I'll ask you the one thing.", "What's it for: a game they play, or practice sheets?"];
    const reply = await askChiefOfStaff("kids maths", []);
    expect(reply.text).toContain("?");
  });

  it("a reply with a question, or with the card, is shown as it is: one turn, no second ask", async () => {
    replies = ["Who's it for, just your two or other parents too?"];
    expect((await askChiefOfStaff("kids maths", [])).text).toBe("Who's it for, just your two or other parents too?");
    expect(prompts).toHaveLength(1);
    replies = [CARD];
    expect((await askChiefOfStaff("kids maths", [])).proposal).toBeDefined();
    expect(prompts).toHaveLength(2);
  });

  it("the note says the chat can't check anything and each reply ends on a question or the card", () => {
    const note = interviewNote("kids maths");
    expect(note).toMatch(/no tools/);
    expect(note).toMatch(/ends with either one question for Ash or the project block/);
  });
});
