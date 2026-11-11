// Tests only: a fresh-eyes review's world without the app. A disk and a clock, a fake Inbox (with the chat that asked), and
// reviewers that answer when the test says.
import type { AskInput } from "../../firstmate/model/steering";
import { isFreshEyesDecisionKey } from "../../hub/model/decisionKey";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import type { EyesDecision, FreshEyesBackend } from "../model/held";
import type { ReviewerPort, ReviewerTurn } from "../model/review";
import { createEyesStorage, type EyesStorage } from "../model/store";

/** A clock the test moves. Leases and waits read it, never the wall. */
export function testClock(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t, advance: (ms: number) => (clock.t += ms) };
  return clock;
}

export type FakeInbox = FreshEyesBackend & {
  asked: AskInput[];
  answered: { project: string; key: string; answer: string; by?: string }[];
  told: { owner: string; requestId: string; text: string }[];
  rows: EyesDecision[];
  /** The person (or whoever `by` names) answers the question with this key. */
  reply(key: string, answer: string, by?: string): void;
};

/**
 * The Inbox as the review uses it. `refuseChats` is a Lead under a Mono: a question from any chat but "gate" is refused,
 * as decisions.rs check_may_ask does. `failAsk` refuses every question.
 */
export function fakeInbox(options: { refuseChats?: boolean; failAsk?: boolean; failTell?: boolean } = {}): FakeInbox {
  const inbox: FakeInbox = {
    asked: [],
    answered: [],
    told: [],
    rows: [],
    async ask(input) {
      if (options.failAsk) throw new Error("The Inbox is not answering.");
      if (options.refuseChats && input.askedBy !== "gate") {
        throw new Error("You are working for a first mate, so your question goes to it, not to the person.");
      }
      inbox.asked.push(input);
      if (!inbox.rows.some((row) => row.project === input.project && row.decisionKey === input.key)) {
        inbox.rows.push({ project: input.project ?? "", decisionKey: input.key, answer: null, state: "open", answeredBy: null });
      }
      return {};
    },
    async answer(project, key, answer, by) {
      // decisions.rs person_only: a review's question is the person's, and the app's own close, nobody else's.
      if (isFreshEyesDecisionKey(key) && by !== undefined && !["user", "person", "app:fresh-eyes"].includes(by)) {
        throw new Error(`Only the person answers a fresh-eyes review; ${by} cannot. It waits in the Inbox until they do.`);
      }
      inbox.answered.push({ project, key, answer, ...(by ? { by } : {}) });
      const row = inbox.rows.find((entry) => entry.project === project && entry.decisionKey === key);
      if (row && row.state === "open") Object.assign(row, { answer, state: "answered", answeredBy: by ?? "person" });
      return {};
    },
    async decisions() {
      return inbox.rows.map((row) => ({ ...row }));
    },
    async tell(owner, requestId, text) {
      if (options.failTell) throw new Error("The chat is gone.");
      inbox.told.push({ owner, requestId, text });
      return {};
    },
    reply(key, answer, by = "user") {
      const row = inbox.rows.find((entry) => entry.decisionKey === key);
      if (!row) throw new Error(`No question under ${key}`);
      Object.assign(row, { answer, state: "answered", answeredBy: by });
    },
  };
  return inbox;
}

/** Reviewers that answer with a fixed text, and remember what they were asked. */
export function answering(text: string | (() => string), seen: ReviewerTurn[] = []): ReviewerPort & { seen: ReviewerTurn[] } {
  return {
    seen,
    ask: async (turn) => {
      seen.push(turn);
      return typeof text === "function" ? text() : text;
    },
  };
}

/** Reviewers that wait until the test lets them go. */
export function waiting(seen: ReviewerTurn[] = []) {
  let release: (text: string) => void = () => undefined;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const port: ReviewerPort & { seen: ReviewerTurn[]; release(text: string): void } = {
    seen,
    release: (text) => release(text),
    ask: async (turn) => {
      seen.push(turn);
      return gate;
    },
  };
  return port;
}

/** A window: its own store over the shared disk, as a second window of the app would have. */
export function windowOn(disk: ReturnType<typeof memoryDisk>, windowId: string, clock = testClock()): EyesStorage {
  return createEyesStorage(disk, { windowId, now: clock.now });
}

export const FINDING = "FINDING: A step is missing.\nBREAK: It stops half way.";
/** What a reviewer says when it finds nothing to break. Silence is not this. */
export const CLEAN = "NO CONCERNS";
