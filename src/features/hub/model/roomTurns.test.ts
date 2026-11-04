// The room's turn rules, without a model: who answers, who may add something, who was addressed, what is never posted,
// the one loop brake, and what each turn is told.
import { describe, expect, it } from "vitest";
import {
  addressedIn,
  answerPick,
  cleanPost,
  failureNotice,
  hostOf,
  isSilent,
  everyoneElse,
  mentionPick,
  MONO_POSTS_CEILING,
  namedPick,
  openingPick,
  plainFailure,
  roomTranscript,
  turnPrompt,
  withRoomMemory,
  type Seat,
} from "./roomTurns";
import { ROOM_RULES } from "./teamSouls";
import { APP_CLI_MISSING } from "../../orchestration/model/orchestration";

const ADA: Seat = { id: "ada", name: "Ada", aliases: ["Host"] };
const BO: Seat = { id: "bo", name: "Bo" };
const ED: Seat = { id: "ed", name: "Ed" };
const CAM: Seat = { id: "cam", name: "Cam" };
const DEE: Seat = { id: "dee", name: "Dee" };
const HIVRA: Seat = { id: "hivra-lead", name: "Hivra lead", aliases: ["Hivra", "Hivra lead"] };
const TEAM = [ADA, BO, ED, CAM];
const WITH_DEE = [...TEAM, DEE];

describe("who answers first", () => {
  it("the room's host, for anything Ash doesn't aim at a seat: a lane question, a dump, a one-word nudge", () => {
    for (const text of ["what's left on the board this week?", "wat now", "remember we agreed fridays", "the new screen's contrast looks off"])
      expect(answerPick([text], WITH_DEE), text).toMatchObject({ id: "ada", by: "lead" });
    expect(answerPick(["hello"], WITH_DEE, "bo")).toMatchObject({ id: "bo", by: "lead" });
    // No lead: the first seat. A lead id that is seated wins; one that isn't falls back to the first seat.
    expect(hostOf([ED, BO])?.id).toBe("ed");
    expect(hostOf([ED, ADA])?.id).toBe("ed");
    expect(hostOf([ED, ADA], "ada")?.id).toBe("ada");
    expect(hostOf([ED, ADA], "missing")?.id).toBe("ed");
    expect(answerPick(["hello"], [])).toBeUndefined();
  });

  it("an @mention wins, by a seat's own name or an alias on that seat; in a batch the latest mention counts", () => {
    expect(mentionPick("@ed what did i say about colours", TEAM)?.id).toBe("ed");
    expect(mentionPick("ok @Ada plan the week", TEAM)?.id).toBe("ada");
    expect(mentionPick("@Host thoughts", TEAM)?.id).toBe("ada");
    expect(mentionPick("@Bo board?", TEAM)?.id).toBe("bo");
    expect(mentionPick("@cos thoughts", TEAM)).toBeUndefined();
    expect(mentionPick("mail me at ash@example.com", TEAM)).toBeUndefined();
    expect(answerPick(["@cam the new screen contrast is off"], WITH_DEE)).toMatchObject({ id: "cam", by: "mention" });
    expect(answerPick(["@ed one", "@cam two"], TEAM)).toMatchObject({ id: "cam", by: "mention" });
  });

  it("a one-member chat goes to that member; a seat Ash opens with answers first", () => {
    expect(answerPick(["anything at all"], [BO])).toMatchObject({ id: "bo", by: "only" });
    expect(answerPick(["ed, can you check this"], TEAM)).toMatchObject({ id: "ed", by: "named" });
    expect(openingPick("hey cam what do you think", TEAM)?.id).toBe("cam");
    expect(openingPick("Bo, put it on the board", TEAM)?.id).toBe("bo");
    expect(openingPick("host: one more thing", TEAM)?.id).toBe("ada");
    expect(openingPick("cos: one more thing", TEAM)).toBeUndefined();
    // Naming a seat inside a sentence isn't aiming the message at it: the host answers and says who takes what.
    expect(answerPick(["ask Cam to slip it a week"], TEAM)).toMatchObject({ id: "ada", by: "lead" });
    expect(namedPick("what does hivra need from me", [...TEAM, HIVRA])?.id).toBe("hivra-lead");
  });

  it("never mistakes 'cos' (because) or '3pm' for a name", () => {
    expect(answerPick(["cos i think we should ship friday"], TEAM)).toMatchObject({ by: "lead" });
    expect(openingPick("call at 3pm about the launch", TEAM)).toBeUndefined();
  });
});

describe("who else may speak", () => {
  it("when Ash names nobody: every seat but the answerer, in the order they sit, whatever he wrote", () => {
    expect(everyoneElse(WITH_DEE, "ada").map((c) => c.id)).toEqual(["bo", "ed", "cam", "dee"]);
    expect(everyoneElse(WITH_DEE, "ed").map((c) => c.id)).toEqual(["ada", "bo", "cam", "dee"]);
  });

  it("the seats a post names: a name or a list of names opening a sentence, closed by a comma or colon, or an @mention", () => {
    const reply = "Heard you. Ed, please check this against Ash's words.\nBo: tickets 8 to 15 are yours. Ping @Cam if a gate applies.";
    expect(addressedIn(reply, TEAM, "ada")).toEqual(["ed", "bo", "cam"]);
    expect(addressedIn("Host, one add for Ash's click list.", TEAM, "cam")).toEqual(["ada"]);
    expect(addressedIn("cos, one add for Ash's click list.", TEAM, "cam")).toEqual([]);
    expect(addressedIn("- ed: check it", TEAM, "ada")).toEqual(["ed"]);
    expect(addressedIn("Retake is up. Ed, Dee, please pass or flag.", WITH_DEE, "bo")).toEqual(["ed", "dee"]);
    expect(addressedIn("Ed and Dee, it's ready for your check.", WITH_DEE, "bo")).toEqual(["ed", "dee"]);
    expect(addressedIn("Bo, Ed: the board moves to Fridays.", TEAM, "ada")).toEqual(["bo", "ed"]);
  });

  it("a list of full names, in any case, with 'and', an Oxford comma, bold or a please, addresses all of them", () => {
    const LEAD: Seat = { id: "tally-lead", name: "Tally lead", aliases: ["Tally", "Tally lead"] };
    const all = ["bo", "ed", "cam"];
    // The baseline's miss (20 Oct): the host asked three seats to check in by name.
    expect(addressedIn("Here, Ash. Ada: I take your asks. Bo, Ed and Cam, please check in with your own line.", TEAM, "ada")).toEqual(all);
    expect(addressedIn("bo, ed and cam: one line each", TEAM, "ada")).toEqual(all);
    expect(addressedIn("Bo, Ed, and Cam, please check in.", TEAM, "ada")).toEqual(all);
    expect(addressedIn("Bo, Ed and Cam please check in with your own line.", TEAM, "ada")).toEqual(all);
    expect(addressedIn("Bo & Ed, can you confirm?", TEAM, "ada")).toEqual(["bo", "ed"]);
    expect(addressedIn("**ed**, please check items 3 and 4.", TEAM, "ada")).toEqual(["ed"]);
    expect(addressedIn("- **Bo:** put these seven on the board", TEAM, "ada")).toEqual(["bo"]);
    expect(addressedIn("Next: Ed and Cam, check it against Ash's words.", TEAM, "ada")).toEqual(["ed", "cam"]);
    expect(addressedIn("Ping @Bo when it's on the board.", TEAM, "ada")).toEqual(["bo"]);
    expect(addressedIn("Tally lead, please confirm scope.", [...TEAM, LEAD], "ada")).toEqual(["tally-lead"]);
  });

  it("talking about a Mono is not addressing it, and nobody addresses themselves", () => {
    expect(addressedIn("Ed's point stands, and Cam agreed.", TEAM, "ada")).toEqual([]);
    expect(addressedIn("Ed and Cam disagree on this", TEAM, "ada")).toEqual([]);
    expect(addressedIn("Ed, note to self", TEAM, "ed")).toEqual([]);
    expect(addressedIn("Because cos is busy we wait.", TEAM, "ed")).toEqual([]);
  });
});

describe("what is never posted, and what a post looks like", () => {
  it("NO_REPLY, nothing, bare acknowledgements, filler and a lone reaction", () => {
    for (const quiet of ["NO_REPLY", " NO_REPLY.", "NO_REPLY - nothing new", "", "Got it.", "+1", "Agreed.", "On it!", "Noted", "Sounds good, thanks!", "Nothing to add.", "<reaction>👍</reaction>", "Checking 07 now.", "Checking the Level 2 retakes of 07 and 10 now.", "Ada treated \"Ye go\" as not a lock. I'm checking Hub memory so a test doesn't sit there as a decision.\n\nNO_REPLY"])
      expect(isSilent(quiet), quiet).toBe(true);
  });
  it("a real take, even one that starts by agreeing or by saying what it looked at", () => {
    for (const take of ["Agreed with ed. One gate: Ash has to say yes to a new Mono.", "Got it: three tickets, all on Hivra.", "Fair on all three. Changes: 1) ...", "On Friday we ship.", "Looking at it differently, we should ship Friday.", "Ship it. The NO_REPLY rule stays as it is."])
      expect(isSilent(take), take).toBe(false);
  });
  it("no label of its own name in front, and no em dashes (Ash's rule)", () => {
    expect(cleanPost("**ed**: 06 passes — 10 doesn't.", "ed")).toBe("06 passes, 10 doesn't.");
    expect(cleanPost("Locked, Ash—everything follows the theme.")).toBe("Locked, Ash, everything follows the theme.");
    expect(cleanPost("Ada said so.", "Ada")).toBe("Ada said so.");
  });
});

describe("the loop brake", () => {
  it("is one ceiling of Mono posts without Ash", () => {
    expect(MONO_POSTS_CEILING).toBe(20);
  });
});

describe("the prompts", () => {
  const transcript = roomTranscript(
    [
      { id: "1", from: "ash", text: "what did we decide about colour?" },
      { id: "2", from: "ed", text: "Colour means status only." },
      { id: "3", from: "app", kind: "notice", text: "Cam couldn't answer: offline." },
    ],
    (id) => TEAM.find((s) => s.id === id)?.name ?? id,
    30,
    "2",
  );

  it("the transcript names who said what and marks the message being answered", () => {
    expect(transcript).toBe("Ash: what did we decide about colour?\n\n>> Ed: Colour means status only.\n\n(app): Cam couldn't answer: offline.");
  });

  it("r61 (A2): each Mono is told its own role, so asked 'what do you do' it doesn't answer as the host", () => {
    const base = { chatName: "Leadership", chatId: "c1", projectId: "hub", seats: TEAM, host: ADA, transcript };
    const ed = turnPrompt({ ...base, me: ED, kind: "answer" });
    const bo = turnPrompt({ ...base, me: BO, kind: "answer" });
    expect(ed).toMatch(/\nYour own role: Ed: a Mono in this chat\./);
    expect(bo).toMatch(/\nYour own role: Bo: a Mono in this chat\./);
    expect(ed).not.toMatch(/Your own role: Ada/);
    expect(ed).not.toMatch(/memory and checks/);
    expect(bo).not.toMatch(/the board and tickets/);
    expect(bo).toContain("never another Mono's");
  });

  it("a room names its project by name with the id, not just the lowercase id", () => {
    const base = { chatName: "Leadership team", chatId: "bark-desk:leadership", projectId: "bark-desk", seats: TEAM, host: ADA, transcript };
    expect(turnPrompt({ ...base, projectName: "Bark Desk", me: ADA, kind: "answer" })).toContain('for project "Bark Desk" (`bark-desk`).');
    // No name known, or the name is the id: as before.
    expect(turnPrompt({ ...base, me: ADA, kind: "answer" })).toContain('for project "bark-desk".');
    expect(turnPrompt({ ...base, projectName: "bark-desk", me: ADA, kind: "answer" })).toContain('for project "bark-desk".');
  });

  it("each turn carries the room rules, the seats' lanes and the conversation as data, and says how its words reach the room", () => {
    const base = { chatName: "Leadership team", chatId: "hub:leadership", projectId: "hub", seats: TEAM, host: ADA, transcript };
    const answer = turnPrompt({ ...base, me: ADA, kind: "answer", batch: 3 });
    expect(answer).toContain(ROOM_RULES);
    expect(answer).toContain("Ash just wrote (3 messages; answer them together). You host this room, so you answer first, now.");
    expect(answer).toContain('say so by name ("PM, ..."), which wakes that Mono.');
    expect(answer).toContain("- Bo: a Mono in this chat.");
    expect(answer).toContain("- Ed: a Mono in this chat.");
    expect(answer).not.toContain("the board and tickets");
    expect(answer).not.toContain("memory and checks");
    expect(answer).toContain("Your reply is posted to the room for you");
    expect(answer).toContain("<room_conversation>\nAsh: what did we decide");
    const member = turnPrompt({ ...base, me: ED, kind: "answer" });
    expect(member).toContain('Answer him first, from your lane. Name a Mono ("CoS, ...") only if it should act.');
    const chime = turnPrompt({ ...base, me: ED, kind: "chime", other: "Ada" });
    expect(chime).toContain("Ada hosts the room and answers Ash first.");
    expect(chime).toContain("Ash wrote to the whole room and Ada has answered. This is your one turn: Ash wrote to everyone");
    expect(chime).toContain("Ash wrote to everyone, so he expects to hear from you too.");
    expect(chime).toContain("Otherwise reply with exactly NO_REPLY only if his message plainly isn't for you or you'd only be repeating.");
    // "ye go" after the host confirmed: one confirmation, the others only if they found something (run f451 3b).
    expect(chime).toContain('If he\'s only giving a go-ahead that Ada has already confirmed, reply with exactly NO_REPLY unless you found something new from your lane; a "pass" or a restated confirmation counts as repeating.');
    expect(chime).toContain("reply with exactly NO_REPLY");
    // Ash's message to the room is for every seat: the rules don't tell a seat that isn't hosting to stay silent
    // (Mac, 21 Oct: "hey" in Leadership got the host alone, the other three answered NO_REPLY by that rule).
    expect(chime).toContain("Answer when it's for you: the person wrote to the room");
    expect(chime).not.toMatch(/you host and Ash wrote/);
    const reply = turnPrompt({ ...base, me: BO, kind: "reply", other: "Ed" });
    expect(reply).toContain("Ed addressed you in the message marked >> below");
    expect(reply).toContain("Answer it or do it, from your lane");
    const back = turnPrompt({ ...base, me: ADA, kind: "back", back: { title: "Launch shortlist", answer: "Base, then Clanker." } });
    expect(back).toContain('start with "Launch shortlist is back"');
    expect(back).toContain("<your_answer>\nBase, then Clanker.\n</your_answer>");
    const busy = turnPrompt({ ...base, me: ED, kind: "reply", other: "Bo", viaTool: true });
    expect(busy).toContain('answer in the room with room_post (room "hub:leadership"), once, and carry on with your work');
    expect(busy).not.toContain("Your reply is posted to the room for you");
  });

  it("the room rules are the basics: who is speaking, answer when it's for you, stop when done; nothing on formats or review rounds", () => {
    for (const rule of ["group chat", "shows who wrote it", "answer when it's for you", "name a mono", "stop when you're done"])
      expect(ROOM_RULES.toLowerCase(), rule).toContain(rule.toLowerCase());
    for (const gone of ["pass from me", "a review ends in", "Locked:", "digest", "short lines", "em dash", "400 characters"]) expect(ROOM_RULES.toLowerCase(), gone).not.toContain(gone.toLowerCase());
    const base = { chatName: "Leadership team", chatId: "hub:leadership", projectId: "hub", seats: TEAM, host: ADA, transcript: "Ash: go" };
    const host = turnPrompt({ ...base, me: ADA, kind: "answer" });
    expect(host).toContain("say so by name");
    expect(host).toContain('("PM, ...")');
    for (const gone of ["400 characters", "em dashes", "short lines", "pass from me"]) expect(host, gone).not.toContain(gone);
  });

  it("a turn that answers a Mono says so, so its words are never saved as Ash's", () => {
    const base = { chatName: "Leadership team", chatId: "hub:leadership", projectId: "hub", seats: TEAM, host: ADA, transcript: "Ash: go" };
    expect(turnPrompt({ ...base, me: ED, kind: "reply", other: "Bo", speaker: "Bo" })).toContain(
      "The message you answer is from Bo, a Mono: never save, record or quote it as Ash's words.",
    );
    expect(turnPrompt({ ...base, me: ADA, kind: "answer", speaker: "Ash" })).not.toContain("a Mono: never save");
  });

  it("a turn ends on how long its post may be; the project's memory goes ahead of the conversation, not after it", () => {
    const base = { chatName: "Leadership team", chatId: "hub:leadership", projectId: "hub", seats: TEAM, host: ADA, transcript: "Ash: go" };
    const answer = turnPrompt({ ...base, me: ADA, kind: "answer" });
    expect(answer.trimEnd().split("\n").at(-1)).toBe(`Now write your post, or exactly ${"NO_REPLY"}.`);
    const busy = turnPrompt({ ...base, me: ED, kind: "reply", other: "Bo", viaTool: true });
    expect(busy.trimEnd().split("\n").at(-1)).toBe("Now answer with room_post, or post nothing.");
    const withMemory = withRoomMemory(answer, "<project_memory>\nTeal is the brand colour.\n</project_memory>");
    expect(withMemory.startsWith("[MonoCode room] You are Ada")).toBe(true);
    expect(withMemory.indexOf("<project_memory>")).toBeLessThan(withMemory.indexOf("<room_conversation>"));
    expect(withMemory.trimEnd().endsWith("or exactly NO_REPLY.")).toBe(true);
    // A prompt without the conversation marker still gets it, at the end.
    expect(withRoomMemory("hello", "<m/>")).toBe("hello\n\n<m/>");
  });

});

describe("what the room says when a turn can't run", () => {
  it("never a raw JavaScript error: the null that reached the room from the preview reads as a plain status", () => {
    const shown = plainFailure("Bo", "Cannot read properties of null (reading 'startsWith')");
    expect(shown).not.toMatch(/Cannot read|null|startsWith/);
    expect(shown).toBe("Bo couldn't start its turn because something in this copy of the app failed. Your message is saved. The details are in Bo's own chat.");
  });
  it("a copy that can't run Claude, a missing login and a busy Mono each say so", () => {
    expect(plainFailure("Bo", APP_CLI_MISSING, "claude")).toBe("Bo isn't connected to Claude in this copy. Your message is saved.");
    expect(plainFailure("Ed", "Harness is not connected", "claude")).toBe("Ed isn't connected to Claude in this copy. Your message is saved.");
    expect(plainFailure("Ed", "Not logged in · Please run /login", "claude")).toBe("Ed isn't signed in to Claude in this copy. Your message is saved.");
    expect(plainFailure("Hivra lead", APP_CLI_MISSING)).toBe("Hivra lead isn't connected to its coding engine in this copy. Your message is saved.");
  });
  it("a real provider message is shown as it is, and the room's notice always names the Mono", () => {
    expect(plainFailure("Ed", "You've hit your usage limit. Resets at 4pm.")).toBe("You've hit your usage limit. Resets at 4pm.");
    expect(failureNotice("Ed", "You've hit your usage limit. Resets at 4pm.")).toBe("Ed couldn't answer: You've hit your usage limit. Resets at 4pm.");
    expect(failureNotice("Ed", "Not logged in · Please run /login", "claude")).toBe("Ed isn't signed in to Claude in this copy. Your message is saved.");
    expect(failureNotice("Ed", "")).toBe("Ed couldn't answer: Its turn did not finish.");
  });
});

describe("r48: a new conversation and the Mono's own cards", () => {
  const base = { chatName: "Leadership team", chatId: "hub:leadership", projectId: "hub", me: ADA, seats: TEAM, host: ADA, kind: "answer" as const, transcript: "Ash: make a marketing chat" };
  it("says this conversation is its own, and what happened to each card, only when there is something to say", () => {
    const plain = turnPrompt(base);
    expect(plain).not.toMatch(/separate from this room's earlier ones|Your Mono cards/);
    const told = turnPrompt({
      ...base,
      conversation: { title: "Make a marketing chat", startedAt: new Date(2026, 9, 22, 15, 57).getTime() },
      cards: [`"Postie": turned down by Ash ("Not this one") at 14:16; nothing was made and no card shows.`],
    });
    expect(told).toContain(`This is the conversation "Make a marketing chat", started 15:57, separate from this room's earlier ones: what Ash asks here is a new ask`);
    expect(told).toContain(`Your Mono cards: "Postie": turned down by Ash ("Not this one") at 14:16`);
    // Before the room's members and rules, so it reads as the turn's own facts.
    expect(told.indexOf("Your Mono cards")).toBeLessThan(told.indexOf("In the room:"));
  });
});
