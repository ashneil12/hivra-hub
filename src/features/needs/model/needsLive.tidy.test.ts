// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import type { Decision } from "../../firstmate/model/steering";
import { decisionWho, factsFromParts, type NeedsParts, type RemoteNeeds } from "./needsLive";
import { needsYou, needsYouQuiet } from "./needsYou";

const NOW = 1_700_000_000_000;
const RAW = "7f3a9c2e-1111-4222-8333-444455556666";
const PROJECTS = [{ id: "hivra", name: "Hivra", folder: "/Users/example/Projects/hivra" }];

function decision(askedBy: string, askedByMono: string | null = null): Decision {
  return {
    project: "/Users/example/Projects/hivra",
    decisionKey: "font",
    question: "Which font for the landing page?",
    options: ["Serif", "Sans"],
    recommended: "Serif",
    askedBy,
    askedByMono,
    waiting: [],
    state: "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  };
}

function parts(remote: Partial<RemoteNeeds> = {}): NeedsParts {
  return {
    remote: { decisions: [], cards: [], watches: [], ...remote },
    rows: [],
    projects: PROJECTS,
    chats: [],
    pages: [],
    delegations: [],
  };
}

beforeEach(() => {
  localStorage.clear();
});

it("does not use a decision's raw asker id as its name", () => {
  expect(decisionWho(decision(RAW))).toBe("Coding team");
  expect(decisionWho(decision("session:9f3a"))).toBe("Coding team");
  expect(decisionWho(decision("Ada"))).toBe("Ada");

  const [item] = needsYouQuiet(factsFromParts(parts({ decisions: [decision(RAW)] })), NOW);
  expect(item?.who).toBe("Coding team");
  expect(item?.who).not.toBe(RAW);
});

it("uses a mono's name, and a raw mono id falls back to the asker", () => {
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify([
      { id: "mono-ada", name: "Ada" },
      { id: "mono-raw", name: RAW },
    ]),
  );
  expect(decisionWho(decision(RAW, "mono-ada"))).toBe("Ada");
  expect(decisionWho(decision("Ada", "mono-raw"))).toBe("Ada");
  expect(decisionWho(decision("Ada", "mono-raw"))).not.toBe(RAW);
});

it("a check's only control is Open", () => {
  const [item] = needsYou(
    {
      checks: [{
        id: "card-1",
        gateKey: "gate/run-1",
        who: "Ada",
        at: NOW,
        sentence: "Ship the Windows build now",
        onOpen: () => {},
        onApprove: () => {},
        onFix: () => {},
      }],
    },
    NOW,
  );
  expect(item?.actions.map((action) => action.label)).toEqual(["Open"]);
});
