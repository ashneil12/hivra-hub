// The room's turn rules, without a model: who answers, who may add something, who was addressed, what is never posted.
import { describe, expect, it } from "vitest";
import {
  addressedIn,
  BOT_TURN_CAP,
  chimePrompt,
  isSilent,
  laneChimes,
  lanePick,
  mentionPick,
  namedPick,
  parseChimes,
  parsePick,
  pickPrompt,
  roomTranscript,
  ruledPick,
  turnPrompt,
  type Seat,
} from "./roomTurns";
import { ROOM_RULES } from "./teamSouls";

const COS: Seat = { id: "chief-of-staff", name: "Chief of Staff" };
const PM: Seat = { id: "projects-manager", name: "Projects Manager" };
const FRANK: Seat = { id: "frank", name: "frank" };
const ALFRED: Seat = { id: "alfred", name: "Alfred" };
const CRIT: Seat = { id: "critiquito", name: "Critiquito" };
const HIVRA: Seat = { id: "hivra-lead", name: "Hivra lead", aliases: ["Hivra", "Hivra lead"] };
const TEAM = [COS, PM, FRANK, ALFRED];
const WITH_CRIT = [...TEAM, CRIT];

describe("who answers first", () => {
  it("an @mention wins, by any of a member's names", () => {
    expect(mentionPick("@frank what did i say about colours", TEAM)?.id).toBe("frank");
    expect(mentionPick("ok @Chief of Staff plan the week", TEAM)?.id).toBe("chief-of-staff");
    expect(mentionPick("@cos thoughts", TEAM)?.id).toBe("chief-of-staff");
    expect(mentionPick("@projects-manager board?", TEAM)?.id).toBe("projects-manager");
    expect(mentionPick("@pm board?", TEAM)?.id).toBe("projects-manager");
    expect(mentionPick("mail me at ash@example.com", TEAM)).toBeUndefined();
  });

  it("an @mention beats a lane match and the room's default; in a batch the latest mention counts", () => {
    expect(ruledPick(["@alfred the new screen contrast is off"], WITH_CRIT)).toMatchObject({ id: "alfred", by: "mention" });
    expect(ruledPick(["@frank one", "@alfred two"], TEAM)).toMatchObject({ id: "alfred", by: "mention" });
  });

  it("a one-member chat always goes to that member", () => {
    expect(ruledPick(["anything at all"], [PM])).toMatchObject({ id: "projects-manager", by: "only" });
  });

  it("a member Ash opens with, or names alone in plain words, answers", () => {
    expect(namedPick("frank, can you check this", TEAM)?.id).toBe("frank");
    expect(namedPick("hey alfred what do you think", TEAM)?.id).toBe("alfred");
    expect(namedPick("pm, put it on the board", TEAM)?.id).toBe("projects-manager");
    expect(namedPick("cos: one more thing", TEAM)?.id).toBe("chief-of-staff");
    expect(namedPick("ask the projects manager to slip it a week", TEAM)?.id).toBe("projects-manager");
    expect(namedPick("what does hivra need from me", [...TEAM, HIVRA])?.id).toBe("hivra-lead");
  });

  it("never mistakes 'cos' (because) or '3pm' for a name, and two names named is nobody", () => {
    expect(namedPick("cos i think we should ship friday", TEAM)).toBeUndefined();
    expect(namedPick("call at 3pm about the launch", TEAM)).toBeUndefined();
    expect(namedPick("frank and alfred disagree on this", TEAM)).toBeUndefined();
    expect(ruledPick(["cos i think we should ship friday"], TEAM)).toBeUndefined();
  });

  it("without a model, a message squarely in one lane goes to that seat", () => {
    expect(lanePick("what's left on the board, any tickets stuck?", TEAM)).toMatchObject({ id: "projects-manager", by: "lanes" });
    expect(lanePick("remember that we agreed never to ship on fridays", TEAM)).toMatchObject({ id: "frank" });
    expect(lanePick("the new screen's contrast and font look off", WITH_CRIT)).toMatchObject({ id: "critiquito" });
    expect(lanePick("should we add a new mono for marketing, who owns it?", TEAM)).toMatchObject({ id: "alfred" });
  });

  it("anything else (a dump, a mix, priorities, chat) goes to Chief of Staff, who says who takes what", () => {
    expect(lanePick("morning! lots today", TEAM)).toMatchObject({ id: "chief-of-staff" });
    expect(lanePick("remember the rule, the board is stale and the screen looks bad", WITH_CRIT)).toMatchObject({ id: "chief-of-staff" });
    expect(lanePick("what should we prioritise this week", TEAM)).toMatchObject({ id: "chief-of-staff" });
    // a design question with no design reviewer seated is not anyone's lane
    expect(lanePick("the new screen's contrast looks off", TEAM)).toMatchObject({ id: "chief-of-staff" });
  });

  it("without Chief of Staff in the chat: the best lane, else the first member", () => {
    expect(lanePick("is the board up to date", [FRANK, PM])).toMatchObject({ id: "projects-manager" });
    expect(lanePick("hello", [FRANK, PM])).toMatchObject({ id: "frank" });
    expect(lanePick("hello", [])).toBeUndefined();
  });
});

describe("who else may speak", () => {
  it("by lane, from Ash's words, in the room's order, never the answerer", () => {
    const text = "remember we agreed the board moves to Fridays, and the screen colours are wrong";
    expect(laneChimes(text, WITH_CRIT, "chief-of-staff").map((c) => c.id)).toEqual(["projects-manager", "frank", "critiquito"]);
    expect(laneChimes(text, WITH_CRIT, "frank").map((c) => c.id)).toEqual(["projects-manager", "critiquito"]);
    expect(laneChimes("thanks!", WITH_CRIT, "chief-of-staff")).toEqual([]);
  });

  it("a Mono a reply addresses (a name opening a line or sentence with a comma or colon, or an @mention)", () => {
    const reply = "Heard you. frank, please check this against Ash's words.\nPM: tickets 8 to 15 are yours. Ping @alfred if a gate applies.";
    expect(addressedIn(reply, TEAM, "chief-of-staff")).toEqual(["frank", "projects-manager", "alfred"]);
    expect(addressedIn("CoS, one add for Ash's click list.", TEAM, "alfred")).toEqual(["chief-of-staff"]);
    expect(addressedIn("- frank: check it", TEAM, "chief-of-staff")).toEqual(["frank"]);
  });

  it("talking about a Mono is not addressing it, and nobody addresses themselves", () => {
    expect(addressedIn("Frank's point stands, and Alfred agreed.", TEAM, "chief-of-staff")).toEqual([]);
    expect(addressedIn("frank, note to self", TEAM, "frank")).toEqual([]);
    expect(addressedIn("Because cos is busy we wait.", TEAM, "frank")).toEqual([]);
  });
});

describe("what is never posted", () => {
  it("NO_REPLY, nothing, bare acknowledgements and a lone reaction", () => {
    for (const quiet of ["NO_REPLY", " NO_REPLY.", "NO_REPLY - nothing new", "", "Got it.", "+1", "Agreed.", "On it!", "Noted", "Sounds good, thanks!", "Nothing to add.", "<reaction>👍</reaction>"])
      expect(isSilent(quiet), quiet).toBe(true);
  });
  it("a real take, even one that starts by agreeing", () => {
    for (const take of ["Agreed with frank. One gate: Ash has to say yes to a new Mono.", "Got it: three tickets, all on Hivra.", "Fair on all three. Changes: 1) ..."])
      expect(isSilent(take), take).toBe(false);
  });
});

describe("the router and the prompts", () => {
  const transcript = roomTranscript(
    [
      { from: "ash", text: "what did we decide about colour?" },
      { from: "frank", text: "Colour means status only." },
    ],
    (id) => TEAM.find((s) => s.id === id)?.name ?? id,
  );

  it("the transcript names who said what", () => {
    expect(transcript).toBe("Ash: what did we decide about colour?\n\nfrank: Colour means status only.");
  });

  it("the pick prompt carries every member's card, the room's default and the conversation as data", () => {
    const prompt = pickPrompt(TEAM, transcript);
    for (const id of TEAM.map((s) => s.id)) expect(prompt).toContain(`- ${id}: `);
    expect(prompt).toContain("Chief of Staff answers Ash first by default");
    expect(prompt).toContain("<conversation>\nAsh: what did we decide");
    expect(prompt).toContain('{"answerer":"<member id>"');
  });

  it("reads the router's one pick, by id or by name, and refuses anyone else", () => {
    expect(parsePick('{"answerer":"frank","why":"memory question"}', TEAM)).toEqual({ id: "frank", why: "memory question", by: "router" });
    expect(parsePick('Sure! {"answerer": "Projects Manager"}', TEAM)).toMatchObject({ id: "projects-manager", by: "router" });
    expect(parsePick('{"answerer":"critiquito"}', TEAM)).toBeUndefined();
    expect(parsePick("frank", TEAM)).toBeUndefined();
  });

  it("reads the chime gate's list: members only, never the answerer, once each, in room order; an empty list is an answer", () => {
    expect(parseChimes('{"chime":[{"id":"alfred","why":"gate"},{"id":"frank","why":"missed ask"},{"id":"frank"},{"id":"chief-of-staff"},{"id":"nobody"}]}', TEAM, "chief-of-staff")).toEqual([
      { id: "frank", why: "missed ask" },
      { id: "alfred", why: "gate" },
    ]);
    expect(parseChimes('{"chime":[]}', TEAM, "chief-of-staff")).toEqual([]);
    expect(parseChimes("nobody", TEAM, "chief-of-staff")).toBeUndefined();
    expect(chimePrompt(TEAM, COS, transcript)).not.toContain("- chief-of-staff:");
  });

  it("each turn carries the room rules; a chime-in and a reply are told to say NO_REPLY when they have nothing new", () => {
    const base = { chatName: "Leadership team", projectId: "hub", seats: TEAM, transcript };
    const answer = turnPrompt({ ...base, me: COS, kind: "answer", batch: 3 });
    expect(answer).toContain(ROOM_RULES);
    expect(answer).toContain("he sent 3 messages while the room was busy");
    expect(answer).toContain("In the chat: Ash, Projects Manager, frank, Alfred.");
    const chime = turnPrompt({ ...base, me: FRANK, kind: "chime", other: "Chief of Staff" });
    expect(chime).toContain("Chief of Staff answered. You may add ONE short reply");
    expect(chime).toContain("reply with exactly NO_REPLY");
    expect(turnPrompt({ ...base, me: PM, kind: "reply", other: "frank" })).toContain("frank addressed you. Reply once");
  });

  it("an exchange is capped at 8 Mono turns", () => {
    expect(BOT_TURN_CAP).toBe(8);
  });
});
