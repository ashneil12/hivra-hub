// The room's turn rules, without a model: who answers, who may add something, who was addressed, what is never posted,
// what counts as progress, and what each turn is told.
import { describe, expect, it } from "vitest";
import {
  addressedIn,
  answerPick,
  chimePrompt,
  cleanPost,
  failureNotice,
  hostOf,
  isProgress,
  isShortMessage,
  isSilent,
  laneChimes,
  mentionPick,
  MONO_POSTS_CEILING,
  namedPick,
  openingPick,
  parseChimes,
  pingPong,
  plainFailure,
  QUIET_CEILING_MS,
  roomTranscript,
  sameSaying,
  turnPrompt,
  withRoomMemory,
  type Seat,
} from "./roomTurns";
import { ROOM_RULES } from "./teamSouls";
import { APP_CLI_MISSING } from "../../orchestration/model/orchestration";

const COS: Seat = { id: "chief-of-staff", name: "Chief of Staff" };
const PM: Seat = { id: "projects-manager", name: "Projects Manager" };
const FRANK: Seat = { id: "frank", name: "frank" };
const ALFRED: Seat = { id: "alfred", name: "Alfred" };
const CRIT: Seat = { id: "critiquito", name: "Critiquito" };
const HIVRA: Seat = { id: "hivra-lead", name: "Hivra lead", aliases: ["Hivra", "Hivra lead"] };
const TEAM = [COS, PM, FRANK, ALFRED];
const WITH_CRIT = [...TEAM, CRIT];

describe("who answers first", () => {
  it("the room's host, for anything Ash doesn't aim at a seat: a lane question, a dump, a one-word nudge", () => {
    for (const text of ["what's left on the board this week?", "wat now", "remember we agreed fridays", "the new screen's contrast looks off"])
      expect(answerPick([text], WITH_CRIT), text).toMatchObject({ id: "chief-of-staff", by: "lead" });
    expect(answerPick(["hello"], WITH_CRIT, "projects-manager")).toMatchObject({ id: "projects-manager", by: "lead" });
    expect(hostOf([FRANK, PM])?.id).toBe("frank");
    expect(hostOf([FRANK, COS])?.id).toBe("chief-of-staff");
    expect(answerPick(["hello"], [])).toBeUndefined();
  });

  it("an @mention wins, by any of a member's names; in a batch the latest mention counts", () => {
    expect(mentionPick("@frank what did i say about colours", TEAM)?.id).toBe("frank");
    expect(mentionPick("ok @Chief of Staff plan the week", TEAM)?.id).toBe("chief-of-staff");
    expect(mentionPick("@cos thoughts", TEAM)?.id).toBe("chief-of-staff");
    expect(mentionPick("@pm board?", TEAM)?.id).toBe("projects-manager");
    expect(mentionPick("mail me at ash@example.com", TEAM)).toBeUndefined();
    expect(answerPick(["@alfred the new screen contrast is off"], WITH_CRIT)).toMatchObject({ id: "alfred", by: "mention" });
    expect(answerPick(["@frank one", "@alfred two"], TEAM)).toMatchObject({ id: "alfred", by: "mention" });
  });

  it("a one-member chat goes to that member; a seat Ash opens with answers first", () => {
    expect(answerPick(["anything at all"], [PM])).toMatchObject({ id: "projects-manager", by: "only" });
    expect(answerPick(["frank, can you check this"], TEAM)).toMatchObject({ id: "frank", by: "named" });
    expect(openingPick("hey alfred what do you think", TEAM)?.id).toBe("alfred");
    expect(openingPick("pm, put it on the board", TEAM)?.id).toBe("projects-manager");
    expect(openingPick("cos: one more thing", TEAM)?.id).toBe("chief-of-staff");
    // Naming a seat inside a sentence isn't aiming the message at it: the host answers and says who takes what.
    expect(answerPick(["ask the projects manager to slip it a week"], TEAM)).toMatchObject({ id: "chief-of-staff", by: "lead" });
    expect(namedPick("what does hivra need from me", [...TEAM, HIVRA])?.id).toBe("hivra-lead");
  });

  it("never mistakes 'cos' (because) or '3pm' for a name", () => {
    expect(answerPick(["cos i think we should ship friday"], TEAM)).toMatchObject({ by: "lead" });
    expect(openingPick("call at 3pm about the launch", TEAM)).toBeUndefined();
  });
});

describe("who else may speak", () => {
  it("by lane, from Ash's words, in the room's order, never the answerer; a short message needs nobody", () => {
    const text = "remember we agreed the board moves to Fridays, and the screen colours are wrong";
    expect(laneChimes(text, WITH_CRIT, "chief-of-staff").map((c) => c.id)).toEqual(["projects-manager", "frank", "critiquito"]);
    expect(laneChimes(text, WITH_CRIT, "frank").map((c) => c.id)).toEqual(["projects-manager", "critiquito"]);
    expect(laneChimes("remember the board", WITH_CRIT, "chief-of-staff")).toEqual([]);
    expect(isShortMessage("skip review just ship the fix pls")).toBe(true);
  });

  it("the seats a post names: a name or a list of names opening a sentence, closed by a comma or colon, or an @mention", () => {
    const reply = "Heard you. frank, please check this against Ash's words.\nPM: tickets 8 to 15 are yours. Ping @alfred if a gate applies.";
    expect(addressedIn(reply, TEAM, "chief-of-staff")).toEqual(["frank", "projects-manager", "alfred"]);
    expect(addressedIn("CoS, one add for Ash's click list.", TEAM, "alfred")).toEqual(["chief-of-staff"]);
    expect(addressedIn("- frank: check it", TEAM, "chief-of-staff")).toEqual(["frank"]);
    expect(addressedIn("Retake is up. frank, Critiquito, please pass or flag.", WITH_CRIT, "projects-manager")).toEqual(["frank", "critiquito"]);
    expect(addressedIn("frank and Critiquito, it's ready for your check.", WITH_CRIT, "projects-manager")).toEqual(["frank", "critiquito"]);
    expect(addressedIn("PM, frank: the board moves to Fridays.", TEAM, "chief-of-staff")).toEqual(["projects-manager", "frank"]);
  });

  it("a list of full names, in any case, with 'and', an Oxford comma, bold or a please, addresses all of them", () => {
    const LEAD: Seat = { id: "tally-lead", name: "Tally lead", aliases: ["Tally", "Tally lead"] };
    const all = ["projects-manager", "frank", "alfred"];
    // The baseline's miss (20 Oct): the host asked three seats to check in by name.
    expect(addressedIn("Here, Ash. Chief of Staff: I take your asks. Projects Manager, frank and Alfred, please check in with your own line.", TEAM, "chief-of-staff")).toEqual(all);
    expect(addressedIn("projects manager, frank and alfred: one line each", TEAM, "chief-of-staff")).toEqual(all);
    expect(addressedIn("Projects Manager, frank, and Alfred, please check in.", TEAM, "chief-of-staff")).toEqual(all);
    expect(addressedIn("Projects Manager, frank and Alfred please check in with your own line.", TEAM, "chief-of-staff")).toEqual(all);
    expect(addressedIn("PM & frank, can you confirm?", TEAM, "chief-of-staff")).toEqual(["projects-manager", "frank"]);
    expect(addressedIn("**frank**, please check items 3 and 4.", TEAM, "chief-of-staff")).toEqual(["frank"]);
    expect(addressedIn("- **PM:** put these seven on the board", TEAM, "chief-of-staff")).toEqual(["projects-manager"]);
    expect(addressedIn("Next: frank and Alfred, check it against Ash's words.", TEAM, "chief-of-staff")).toEqual(["frank", "alfred"]);
    expect(addressedIn("Ping @Projects Manager when it's on the board.", TEAM, "chief-of-staff")).toEqual(["projects-manager"]);
    expect(addressedIn("Tally lead, please confirm scope.", [...TEAM, LEAD], "chief-of-staff")).toEqual(["tally-lead"]);
  });

  it("talking about a Mono is not addressing it, and nobody addresses themselves", () => {
    expect(addressedIn("Frank's point stands, and Alfred agreed.", TEAM, "chief-of-staff")).toEqual([]);
    expect(addressedIn("frank and alfred disagree on this", TEAM, "chief-of-staff")).toEqual([]);
    expect(addressedIn("frank, note to self", TEAM, "frank")).toEqual([]);
    expect(addressedIn("Because cos is busy we wait.", TEAM, "frank")).toEqual([]);
  });
});

describe("what is never posted, and what a post looks like", () => {
  it("NO_REPLY, nothing, bare acknowledgements, filler and a lone reaction", () => {
    for (const quiet of ["NO_REPLY", " NO_REPLY.", "NO_REPLY - nothing new", "", "Got it.", "+1", "Agreed.", "On it!", "Noted", "Sounds good, thanks!", "Nothing to add.", "<reaction>👍</reaction>", "Checking 07 now.", "Checking the Level 2 retakes of 07 and 10 now."])
      expect(isSilent(quiet), quiet).toBe(true);
  });
  it("a real take, even one that starts by agreeing or by saying what it looked at", () => {
    for (const take of ["Agreed with frank. One gate: Ash has to say yes to a new Mono.", "Got it: three tickets, all on Hivra.", "Fair on all three. Changes: 1) ...", "On Friday we ship.", "Looking at it differently, we should ship Friday."])
      expect(isSilent(take), take).toBe(false);
  });
  it("no label of its own name in front, and no em dashes (Ash's rule)", () => {
    expect(cleanPost("**frank**: 06 passes — 10 doesn't.", "frank")).toBe("06 passes, 10 doesn't.");
    expect(cleanPost("Locked, Ash—everything follows the theme.")).toBe("Locked, Ash, everything follows the theme.");
    expect(cleanPost("Chief of Staff said so.", "Chief of Staff")).toBe("Chief of Staff said so.");
  });
});

describe("progress", () => {
  it("a post that repeats a recent one is no progress; new ground is", () => {
    expect(sameSaying("frank, the board moves to Fridays, noted.", "PM, the board moves to Fridays, noted.")).toBe(true);
    expect(isProgress("06 passes from me.", ["Round 3 is ready: 9 screens.", "PM, 06 doesn't do what Ash asked."])).toBe(true);
    expect(isProgress("The board moves to Fridays, noted.", ["the board moves to fridays noted"])).toBe(false);
  });
  it("two seats alternating for the whole tail is a ping-pong; a third voice breaks it", () => {
    const ab = Array.from({ length: 8 }, (_, i) => (i % 2 ? "frank" : "projects-manager"));
    expect(pingPong(ab)).toBe(true);
    expect(pingPong(ab.slice(1))).toBe(false);
    expect(pingPong([...ab.slice(0, 7), "chief-of-staff"])).toBe(false);
  });
  it("the ceiling is 40 Mono posts or 30 minutes without Ash", () => {
    expect(MONO_POSTS_CEILING).toBe(40);
    expect(QUIET_CEILING_MS).toBe(30 * 60_000);
  });
});

describe("the gate and the prompts", () => {
  const transcript = roomTranscript(
    [
      { id: "1", from: "ash", text: "what did we decide about colour?" },
      { id: "2", from: "frank", text: "Colour means status only." },
      { id: "3", from: "app", kind: "notice", text: "Alfred couldn't answer: offline." },
    ],
    (id) => TEAM.find((s) => s.id === id)?.name ?? id,
    30,
    "2",
  );

  it("the transcript names who said what and marks the message being answered", () => {
    expect(transcript).toBe("Ash: what did we decide about colour?\n\n>> frank: Colour means status only.\n\n(app): Alfred couldn't answer: offline.");
  });

  it("reads the chime gate's list: members only, never the answerer, once each, in room order; an empty list is an answer", () => {
    expect(parseChimes('{"chime":[{"id":"alfred","why":"gate"},{"id":"frank","why":"missed ask"},{"id":"frank"},{"id":"chief-of-staff"},{"id":"nobody"}]}', TEAM, "chief-of-staff")).toEqual([
      { id: "frank", why: "missed ask" },
      { id: "alfred", why: "gate" },
    ]);
    expect(parseChimes('{"chime":[]}', TEAM, "chief-of-staff")).toEqual([]);
    expect(parseChimes("nobody", TEAM, "chief-of-staff")).toBeUndefined();
    expect(chimePrompt(TEAM, COS, transcript)).not.toContain("- chief-of-staff:");
    expect(chimePrompt(TEAM, COS, transcript)).toContain("pushback when he asks for something that clashes with an earlier decision");
    expect(chimePrompt(TEAM, PM, transcript, "post")).toContain("must look at it now");
  });

  it("each turn carries the room rules, the seats' lanes and the conversation as data, and says how its words reach the room", () => {
    const base = { chatName: "Leadership team", chatId: "hub:leadership", projectId: "hub", seats: TEAM, host: COS, transcript };
    const answer = turnPrompt({ ...base, me: COS, kind: "answer", batch: 3 });
    expect(answer).toContain(ROOM_RULES);
    expect(answer).toContain("Ash just wrote (3 messages; answer them together). You host this room, so you answer first, now.");
    expect(answer).toContain("- Projects Manager: the board and tickets");
    expect(answer).toContain("Your reply is posted to the room for you");
    expect(answer).toContain("<room_conversation>\nAsh: what did we decide");
    const chime = turnPrompt({ ...base, me: FRANK, kind: "chime", other: "Chief of Staff" });
    expect(chime).toContain("Chief of Staff hosts the room and answers Ash first.");
    expect(chime).toContain("Chief of Staff answered Ash. You may add ONE short message");
    expect(chime).toContain("reply with exactly NO_REPLY");
    const reply = turnPrompt({ ...base, me: PM, kind: "reply", other: "frank" });
    expect(reply).toContain("frank addressed you in the message marked >> below");
    expect(reply).toContain('"That\'s Ash\'s call"');
    expect(turnPrompt({ ...base, me: COS, kind: "digest", seatsSpoke: 4 })).toContain("4 seats have spoken since Ash's last message");
    const back = turnPrompt({ ...base, me: COS, kind: "back", back: { title: "Launch shortlist", answer: "Base, then Clanker." } });
    expect(back).toContain('start with "Launch shortlist is back"');
    expect(back).toContain("<your_answer>\nBase, then Clanker.\n</your_answer>");
    const busy = turnPrompt({ ...base, me: FRANK, kind: "reply", other: "PM", viaTool: true });
    expect(busy).toContain('answer in the room with room_post (room "hub:leadership"), once, and carry on with your work');
    expect(busy).not.toContain("Your reply is posted to the room for you");
  });

  it("posts are short and point to the detail; reviews verify and close; Ash is asked only what is his call", () => {
    for (const rule of ["400 characters", "a file path, a commit, a test count", "only the host", "check it yourself", "a review ends in", "Locked:", "truly his call"])
      expect(ROOM_RULES.toLowerCase(), rule).toContain(rule.toLowerCase());
    const base = { chatName: "Leadership team", chatId: "hub:leadership", projectId: "hub", seats: TEAM, host: COS, transcript: "Ash: go" };
    const host = turnPrompt({ ...base, me: COS, kind: "answer" });
    expect(host).toContain("one short line each");
    // Ash sees the host's words as they are written: its first line comes before any tool call (a brief to a Lead).
    expect(host).toContain("Write that first line before you call any tool");
    expect(host).toContain("Don't list his asks back");
    expect(host).toContain("2 to 5 short lines");
    const reviewer = turnPrompt({ ...base, me: FRANK, kind: "reply", other: "Projects Manager" });
    expect(reviewer).toContain("check it yourself first");
    expect(reviewer).toContain('"pass from me"');
    const digest = turnPrompt({ ...base, me: COS, kind: "digest", seatsSpoke: 3 });
    expect(digest).toContain("Locked:");
    expect(digest).toContain("only when every reviewer has passed");
  });

  it("a turn ends on how long its post may be; the project's memory goes ahead of the conversation, not after it", () => {
    const base = { chatName: "Leadership team", chatId: "hub:leadership", projectId: "hub", seats: TEAM, host: COS, transcript: "Ash: go" };
    const answer = turnPrompt({ ...base, me: COS, kind: "answer" });
    expect(answer.trimEnd().split("\n").at(-1)).toBe(`Now write your post: 2 to 5 short lines, under about 400 characters, or exactly ${"NO_REPLY"}.`);
    const busy = turnPrompt({ ...base, me: FRANK, kind: "reply", other: "PM", viaTool: true });
    expect(busy.trimEnd().split("\n").at(-1)).toBe("Now answer with room_post (2 to 5 short lines, under about 400 characters), or post nothing.");
    const withMemory = withRoomMemory(answer, "<project_memory>\nTeal is the brand colour.\n</project_memory>");
    expect(withMemory.startsWith("[MonoCode room] You are Chief of Staff")).toBe(true);
    expect(withMemory.indexOf("<project_memory>")).toBeLessThan(withMemory.indexOf("<room_conversation>"));
    expect(withMemory.trimEnd().endsWith("or exactly NO_REPLY.")).toBe(true);
    // A prompt without the conversation marker still gets it, at the end.
    expect(withRoomMemory("hello", "<m/>")).toBe("hello\n\n<m/>");
  });

  it("an unanswered question to Ash is never asked again and never holds up the rest; flags name the builder", () => {
    for (const rule of ["never ask it again", "doesn't hold up", "name the builder"])
      expect(ROOM_RULES.toLowerCase(), rule).toContain(rule.toLowerCase());
    const base = { chatName: "Leadership team", chatId: "hub:leadership", projectId: "hub", seats: TEAM, host: COS, transcript: "Ash: go" };
    expect(turnPrompt({ ...base, me: COS, kind: "digest", seatsSpoke: 3 })).toContain("don't ask it again");
  });

  it("the room rules carry what the Grok room did and what it must not copy", () => {
    for (const rule of ["answers Ash first", "by name", "pass from me", "Stand down out loud", "skip review", "That's Ash's call", "Locked", "is back", "no em dashes", "don't just agree"])
      expect(ROOM_RULES.toLowerCase()).toContain(rule.toLowerCase());
  });
});

describe("what the room says when a turn can't run", () => {
  it("never a raw JavaScript error: the null that reached the room from the preview reads as a plain status", () => {
    const shown = plainFailure("Projects Manager", "Cannot read properties of null (reading 'startsWith')");
    expect(shown).not.toMatch(/Cannot read|null|startsWith/);
    expect(shown).toBe("Projects Manager couldn't start its turn because something in this copy of the app failed. Your message is saved. The details are in Projects Manager's own chat.");
  });
  it("a copy that can't run Claude, a missing login and a busy Mono each say so", () => {
    expect(plainFailure("Projects Manager", APP_CLI_MISSING, "claude")).toBe("Projects Manager isn't connected to Claude in this copy. Your message is saved.");
    expect(plainFailure("frank", "Harness is not connected", "claude")).toBe("frank isn't connected to Claude in this copy. Your message is saved.");
    expect(plainFailure("frank", "Not logged in · Please run /login", "claude")).toBe("frank isn't signed in to Claude in this copy. Your message is saved.");
    expect(plainFailure("Hivra lead", APP_CLI_MISSING)).toBe("Hivra lead isn't connected to its coding engine in this copy. Your message is saved.");
  });
  it("a real provider message is shown as it is, and the room's notice always names the Mono", () => {
    expect(plainFailure("frank", "You've hit your usage limit. Resets at 4pm.")).toBe("You've hit your usage limit. Resets at 4pm.");
    expect(failureNotice("frank", "You've hit your usage limit. Resets at 4pm.")).toBe("frank couldn't answer: You've hit your usage limit. Resets at 4pm.");
    expect(failureNotice("frank", "Not logged in · Please run /login", "claude")).toBe("frank isn't signed in to Claude in this copy. Your message is saved.");
    expect(failureNotice("frank", "")).toBe("frank couldn't answer: Its turn did not finish.");
  });
});
