// @vitest-environment happy-dom
// The user's name is substituted in the frames that go through forUser or userLabel. Ash's pack says Ash and keeps
// he/him/his. A fresh install named Sam does not say Ash in those frames. No stored prompt is compared byte for byte.
import { beforeEach, describe, expect, it } from "vitest";
import { monoRole } from "../../monos/model/mono";
import { promptSurfaces } from "./promptSurfaces.testkit";
import { roomTranscript } from "./roomTurns";
import { setTeamPack } from "./teamPack";
import { forUser, forYou, setUserName, userLabel, userName } from "./userName";

const PRONOUN = /\b(he|him|his|himself)\b/gi;
const pronounLeaks = (surfaces: Record<string, string>) =>
  Object.entries(surfaces).flatMap(([k, t]) => [...t.matchAll(PRONOUN)].map((m) => `${k}: ${t.slice(Math.max(0, m.index! - 30), m.index! + 20)}`));
const storage = () => Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]));
/** Every frame promptSurfaces builds. A leak in any of them is a leak. */
const nameLeaks = (surfaces: Record<string, string>) => Object.entries(surfaces).filter(([, t]) => /\bAsh\b/.test(t)).map(([k]) => k);

beforeEach(() => {
  localStorage.clear();
});

describe("Ash's install", () => {
  it("says Ash, keeps the words as written, and writes nothing", () => {
    localStorage.setItem("monocode:mono-team-seeded", "1");
    const before = storage();
    const now = promptSurfaces();
    expect(userName()).toBe("Ash");
    expect(forUser("Answer him first; he writes his own.")).toBe("Answer him first; he writes his own.");
    expect(now["turn:answer"]).toContain("Ash just wrote to you.");
    expect(now["turn:answer"]).toContain("Answer him first");
    expect(now.transcript).toMatch(/^>> Ash: hey team/);
    expect(storage()).toEqual(before);
    expect(now["lead:hub-lead"]).toBeUndefined();
  });

  it("keeps his pronouns too: he, him and his are only swapped off his install", () => {
    localStorage.setItem("monocode:mono-team-seeded", "1");
    expect(pronounLeaks(promptSurfaces()).length).toBeGreaterThan(10);
    expect(forUser("Answer him first; he writes his own.")).toBe("Answer him first; he writes his own.");
  });

  it("reads Ash when the pack is set to his, too", () => {
    localStorage.setItem("monocode:hub-team-pack", "ash");
    const before = storage();
    const now = promptSurfaces();
    expect(userName()).toBe("Ash");
    expect(now["turn:answer"]).toContain("Ash just wrote to you.");
    expect(now.checker).toContain("After Ash sends a dump");
    expect(storage()).toEqual(before);
  });
});

describe("a fresh install", () => {
  it('named "Sam": those frames name Sam, not Ash', () => {
    setUserName("Sam");
    const before = storage();
    const now = promptSurfaces();
    expect(nameLeaks(now)).toEqual([]);
    expect(now["turn:answer"]).toContain("Sam just wrote to you.");
    expect(now["turn:answer"]).toContain("Answer them first");
    expect(now["turn:answer"]).toContain("In the room: Sam");
    expect(now["turn:answer"]).toContain("Sam's messages are their words");
    expect(now.transcript).toMatch(/^>> Sam: hey team/);
    expect(now["lead:extra"]).toContain("You are Shop lead, the lead for Shop (project `shop`)");
    expect(now["lead:extra"]).toContain("You are a first mate.");
    expect(now["lead:hub-lead"]).toBeUndefined();
    expect(now["lead:extra"]).not.toContain("15 Oct");
    expect(now.hubNote).toContain("Deletes need Sam's own yes.");
    expect(now.checker).toContain("After Sam sends a dump");
    expect(pronounLeaks(now)).toEqual([]);
    expect(storage()).toEqual(before);
  });

  it('with no name: agents read "the user", capitalised at a sentence\'s start', () => {
    const now = promptSurfaces();
    expect(nameLeaks(now)).toEqual([]);
    expect(now["turn:answer"]).toContain("The user just wrote to you.");
    expect(now.checker).toContain("After the user sends a dump");
    expect(now.transcript).toMatch(/^>> User: hey team/);
    expect(userLabel()).toBe("User");
    expect(pronounLeaks(now)).toEqual([]);
    expect(now["turn:chime"]).toContain("so the user expects to hear from you too");
  });

  it("leaves what goes into a template alone: a message that names Ash stays as written", () => {
    setUserName("Sam");
    expect(roomTranscript([{ from: "ash", text: "tell Ash OS" }], (id) => id)).toBe("Sam: tell Ash OS");
    expect(forUser`Ask Ash about ${"Ash's"} note.`).toBe("Ask Sam about Ash's note.");
  });

  it("says you and your on the app's own screens", () => {
    expect(forYou("Stopped by Ash.")).toBe("Stopped by you.");
    expect(forYou("Ash's red list. Ash OS is down")).toBe("Your red list. Hub OS is down");
    expect(forYou("ask Ash only when it can't go on without him.")).toBe("ask you only when it can't go on without you.");
    setTeamPack("ash");
    expect(forYou("Stopped by Ash.")).toBe("Stopped by Ash.");
  });
});

describe("the role line under each name", () => {
  it("is the role that Mono was given, or the Lead line, on a fresh install and on Ash's", () => {
    const lines = () => [
      monoRole({ id: "mina" }),
      monoRole({ id: "mina", role: "Keeps the books" }),
      monoRole({ id: "shop-lead" }),
      monoRole({ id: "shop-lead", role: "Kept" }),
    ];
    expect(lines()).toEqual([undefined, "Keeps the books", "Runs the coding team", "Runs the coding team"]);
    localStorage.setItem("monocode:mono-team-seeded", "1");
    expect(lines()).toEqual([undefined, "Keeps the books", "Runs the coding team", "Runs the coding team"]);
  });
});
