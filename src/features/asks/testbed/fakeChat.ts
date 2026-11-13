// The long-chat test bed's generator (docs/specs/mono-chat-memory.md, phase 0): a made-up first-mate chat of any
// length, the same every time for the same seed, in the style the ledger has to cope with: long unnumbered messages,
// several asks in one breath, filler, and corrections. It plants facts at known places and messages with a known
// number of asks, so a test can count what the app's no-model paths find. Every line is example data.

import type { Block } from "../../sessions/model/session";

export type PlantedFact = { blockId: string; index: number; words: string; text: string };
export type PlantedAsks = { blockId: string; index: number; asks: string[] };

export type FakeChat = {
  id: string;
  title: string;
  blocks: Block[];
  facts: PlantedFact[];
  askMessages: PlantedAsks[];
};

/** A small seeded generator (mulberry32), so a chat is the same on every run. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILLER = [
  "ok that looks fine to me",
  "hmm not sure about the spacing there but lets move on",
  "yeah the build went through on my side",
  "nice, thats what i meant",
  "i was looking at the sidebar again and it feels calmer now",
  "lol ok",
  "that one took a while but it works",
  "the colours are a bit loud in the dark theme tbh",
];

const REPLIES = [
  "Example: done, and the checks passed.",
  "Example: I looked at it and nothing needs changing.",
  "Example: that is in, with one follow-up noted.",
  "Example: started, I will say when it lands.",
];

const SUBJECTS = ["harbour", "lantern", "orchard", "compass", "granite", "velvet", "saffron", "tundra", "marble", "willow", "ember", "quartz"];
const THINGS = ["invoice export", "login screen", "weekly report", "backup job", "pricing page", "search box", "onboarding tour", "release notes"];

const ASK_FORMS = [
  (thing: string) => `can you fix the ${thing} so it stops flickering`,
  (thing: string) => `please add a test for the ${thing}`,
  (thing: string) => `we need to rename the ${thing} before the launch`,
  (thing: string) => `make sure the ${thing} still works after a restart`,
  (thing: string) => `also check why the ${thing} is slow on the first load`,
  (thing: string) => `could you write up what changed in the ${thing}`,
];

const DAY = 24 * 60 * 60 * 1000;

/**
 * `messages` counts Ash's messages and the replies together. A fact is planted about every 50 messages and a
 * several-ask message about every 40, so even the 100-message chat holds a couple of each.
 */
export function fakeChat(messages: number, seed = 7, startAt = 1_790_000_000_000): FakeChat {
  const next = rng(seed + messages);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)];
  const blocks: Block[] = [];
  const facts: PlantedFact[] = [];
  const askMessages: PlantedAsks[] = [];
  const step = (30 * DAY) / Math.max(1, messages);
  for (let index = 0; index < messages; index += 2) {
    const at = Math.floor(startAt + index * step);
    const id = `u${index}`;
    let text: string;
    if (index % 50 === 10) {
      // A fact with two words that appear nowhere else in the chat.
      const a = `${pick(SUBJECTS)}${index}`;
      const b = `${pick(SUBJECTS)}${index + 1}`;
      text = `${pick(FILLER)}. Example: the code name for the ${pick(THINGS)} is ${a} ${b}, keep that in mind. ${pick(FILLER)}`;
      facts.push({ blockId: id, index, words: `${a} ${b}`, text });
    } else if (index % 40 === 24) {
      const count = 3 + Math.floor(next() * 4);
      const asks = Array.from({ length: count }, (_, k) => ASK_FORMS[(index / 2 + k) % ASK_FORMS.length](`${THINGS[(index + k) % THINGS.length]} on screen ${index + k}`));
      // Each ask names its own screen: the same ask said twice in a chat is folded into one by the ledger.
      // One breath, no numbers: asks joined the way a spoken rant is, with filler between some of them.
      text = `Example: ${asks.map((ask, k) => (k % 2 ? `${ask}. ${pick(FILLER)}.` : `${ask}.`)).join(" ")}`;
      askMessages.push({ blockId: id, index, asks });
    } else {
      text = `Example: ${pick(FILLER)}`;
    }
    blocks.push({ id, role: "user", text, startedAt: at } as Block);
    if (index + 1 < messages) blocks.push({ id: `a${index + 1}`, role: "assistant", text: pick(REPLIES), startedAt: at + 1000 } as Block);
  }
  return { id: `fake-${messages}`, title: `Example: ${messages}-message chat`, blocks, facts, askMessages };
}
