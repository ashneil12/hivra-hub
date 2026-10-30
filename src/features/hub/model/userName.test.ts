// @vitest-environment happy-dom
// G5, 21 Oct: the app's instructions to agents name this install's user, not Ash. Ash's own install (his team, or the
// pack set to his) reads "Ash" without anything written, so every prompt is byte for byte what 4b7bb1b built — apart
// from the Lead "Needs Ash" line, rewritten on 23 Oct (D3), and the room rules' task_status line (27 Oct, H6) the roles-ask line (29 Oct, r66) the Lead real-asks line (29 Oct, r67) and the Lead say-each-start-once line and the Lead ask-before-Ash's-choice line (29 Oct, r73) (29 Oct, r72) and the Lead save-Ash's-answers memory line (29 Oct, r76) and the Lead short-briefs, two-minute start and no-hand-worktree lines with the coding-team chat rules (29 Oct, r77) and the Lead give-each-job-its-files line (30 Oct, r87) and the Lead no-overreach line (30 Oct, r97) and the Lead repeat-a-still-open-ask line (30 Oct, r98), each carried
// in the fixture the same day.
import BEFORE_JSON from "./testdata/ashPrompts.4b7bb1b.json";
import { beforeEach, describe, expect, it } from "vitest";
import { monoRole } from "../../monos/model/mono";
import { promptSurfaces } from "./promptSurfaces.testkit";
import { roomTranscript } from "./roomTurns";
import { setTeamPack } from "./teamPack";
import { forUser, forYou, setUserName, userLabel, userName } from "./userName";

const BEFORE: Record<string, string> = BEFORE_JSON;
/** He, him, his: in every surface these meant Ash. Unrelated uses would be listed here as [surface, phrase]; none exist. */
const PRONOUN = /\b(he|him|his|himself)\b/gi;
const ALLOWED: readonly [string, string][] = [];
const pronounLeaks = (surfaces: Record<string, string>) =>
  Object.entries(surfaces).flatMap(([k, t]) =>
    [...t.matchAll(PRONOUN)]
      .map((m) => t.slice(Math.max(0, m.index! - 30), m.index! + 20))
      .filter((around) => !ALLOWED.some(([key, phrase]) => key === k && around.includes(phrase)))
      .map((around) => `${k}: ${around}`),
  );
const storage = () => Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]));

beforeEach(() => {
  localStorage.clear();
});

describe("Ash's install", () => {
  it("builds every prompt surface byte for byte as before, and writes nothing", () => {
    localStorage.setItem("monocode:mono-team-seeded", "1");
    const before = storage();
    const now = promptSurfaces();
    expect(userName()).toBe("Ash");
    expect(Object.keys(now).sort()).toEqual(Object.keys(BEFORE).sort());
    for (const [k, text] of Object.entries(BEFORE)) expect(now[k], k).toBe(text);
    expect(storage()).toEqual(before);
  });

  it("keeps his pronouns too: he, him and his are only swapped off his install", () => {
    localStorage.setItem("monocode:mono-team-seeded", "1");
    expect(pronounLeaks(promptSurfaces()).length).toBeGreaterThan(10);
    expect(forUser("Answer him first; he writes his own.")).toBe("Answer him first; he writes his own.");
  });

  it("reads Ash when the pack is set to his, too", () => {
    localStorage.setItem("monocode:hub-team-pack", "ash");
    expect(promptSurfaces()).toEqual(BEFORE);
  });
});

describe("a fresh install", () => {
  it('named "Sam": no Ash anywhere in the frame, souls, Leads, checker, primer or notices', () => {
    setUserName("Sam");
    const now = promptSurfaces();
    const leaks = Object.entries(now).filter(([, t]) => /\bAsh\b/.test(t)).map(([k]) => k);
    expect(leaks).toEqual([]);
    expect(now["turn:answer"]).toContain("Sam just wrote to you.");
    expect(now["turn:answer"]).toContain("In the room: Sam");
    expect(now.transcript).toMatch(/^>> Sam: hey team/);
    expect(now["lead:hub-lead"]).toContain("Hub OS project `hub`");
    expect(now["lead:hub-lead"]).not.toContain("15 Oct"); // Ash's dated quotes are his words, not Sam's
    expect(pronounLeaks(now)).toEqual([]);
    expect(now["lead:hub-lead"]).toContain("answer them at once whenever Sam writes");
    expect(now.hubNote).toContain("Deletes need Sam's own yes.");
    expect(now["turn:answer"]).toContain("Sam's messages are their words");
  });

  it("with no name: agents read \"the user\", capitalised at a sentence's start", () => {
    const now = promptSurfaces();
    expect(Object.entries(now).filter(([, t]) => /\bAsh\b/.test(t)).map(([k]) => k)).toEqual([]);
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

describe("the role line under each name (G4)", () => {
  it("is the same on a fresh install and on Ash's", () => {
    const lines = () => ["chief-of-staff", "projects-manager", "frank", "alfred", "critiquito"].map((id) => monoRole({ id }));
    const fresh = lines();
    expect(fresh).toEqual(["Business partner", "Screens and board", "Memory and checks", "Team setup", "Design review"]);
    localStorage.setItem("monocode:mono-team-seeded", "1");
    expect(lines()).toEqual(fresh);
  });
});
