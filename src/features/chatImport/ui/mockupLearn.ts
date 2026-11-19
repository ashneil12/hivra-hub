// The design mockup only: a stand-in for the rule reading, so the whole setup can be walked through with example data.
import { setLearnRunStatus } from "../../memory/ui/learnRunStore";

export const inMockup = (): boolean => typeof window !== "undefined" && (window as { __MONOCODE_MOCKUP__?: boolean }).__MONOCODE_MOCKUP__ === true;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function mockupLearn(): Promise<void> {
  const target = 60;
  setLearnRunStatus({ phase: "listing", read: 0, target: 0, chats: 0, proposals: [], leftOut: 0, tooBig: 0, note: "" });
  await wait(1200);
  for (let read = 0; read <= target; read += 6) {
    setLearnRunStatus({ phase: "reading", read, target });
    await wait(500);
  }
  setLearnRunStatus({ phase: "asking", read: target, target, chats: target });
  await wait(2500);
  setLearnRunStatus({
    phase: "done",
    chats: target,
    proposals: [
      { id: "ex-1", title: "Example: updates as one paragraph", diff: "+ End every piece of work with one plain-English paragraph: what changed, what was checked, what is left.", quotes: [{ sessionId: "ex", quote: "Example: just give me one paragraph, not a list of everything you did." }, { sessionId: "ex", quote: "Example: too long. One paragraph." }] },
      { id: "ex-2", title: "Example: small pull requests", diff: "+ Keep each pull request to one change, opened ready for review, never as a draft.", quotes: [{ sessionId: "ex", quote: "Example: split this up, I can't review 40 files." }] },
      { id: "ex-3", title: "Example: show before and after", diff: "+ Any change a person can see comes with a before and an after screenshot.", quotes: [{ sessionId: "ex", quote: "Example: it still looks the same to me. Show me." }] },
      { id: "ex-4", title: "Example: make the call", diff: "+ When a step can be undone, decide and say what you chose instead of asking.", quotes: [{ sessionId: "ex", quote: "Example: don't ask me, just pick one and tell me." }] },
      { id: "ex-5", title: "Example: plain words", diff: "+ Write for someone who has not seen the code: no internal names, no jargon.", quotes: [{ sessionId: "ex", quote: "Example: I don't know what that means. Say it normally." }], note: "Seen in 3 of your projects." },
    ],
  });
}
