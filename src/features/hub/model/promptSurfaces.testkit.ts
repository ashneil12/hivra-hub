// Every generated prompt surface an agent reads, built from fixed inputs (userName.test.ts): the group-chat frame and
// its room rules, the Lead souls, the checker, the memory primer, the hub note and the notices the app sends. Ash's
// install must build these byte for byte as before the user-name setting; a fresh install named "Sam" none with "Ash".
import { handBackText } from "../../autopilot/model/decide";
import type { Delegation } from "../../monos/model/delegations";
import { questionWakeMessage } from "../../monos/model/delegationQuestions";
import { reportRequest } from "../../monos/model/followedBriefs";
import { codingTeamContext, hubNote, monoProjectsBrief } from "../../monos/model/monoFiles";
import { CHECKER_RULES } from "./checkerRules";
import { dumpCheck } from "./dumpCheck";
import { checkerRosterEntry } from "./hubChecker";
import { LEADS, leadSoul } from "./hubLeads";
import { memoryPrimerBlock } from "./hubMemoryPrimer";
import { soulFromBrief } from "./hubTeams";
import { forUser } from "./userName";
import { answerPick, roomTranscript, turnPrompt, type Seat, type TurnInput } from "./roomTurns";

const SEATS: Seat[] = [
  { id: "ada", name: "Chief of Staff" },
  { id: "bo", name: "Projects Manager" },
  { id: "ed", name: "ed" },
  { id: "cam", name: "Alfred" },
  { id: "dee", name: "Critiquito" },
];
const MESSAGES = [
  { id: "m1", from: "ash", text: "hey team, what's left?", at: 1 },
  { id: "m2", from: "ada", text: "Two things.", at: 2 },
  { id: "m3", from: "app", kind: "notice", text: "ed is typing", at: 3 },
];

export function promptSurfaces(): Record<string, string> {
  const out: Record<string, string> = {};
  const transcript = roomTranscript(MESSAGES, (id) => SEATS.find((s) => s.id === id)?.name ?? id, 30, "m1");
  out.transcript = transcript;
  const base = { chatName: "Leadership", chatId: "c1", projectId: "hub", seats: SEATS, host: SEATS[0], transcript } satisfies Partial<TurnInput>;
  const turns: [string, Partial<TurnInput>][] = [
    ["answer-host", { me: SEATS[0], kind: "answer", batch: 2 }],
    ["answer", { me: SEATS[1], kind: "answer" }],
    ["chime", { me: SEATS[2], kind: "chime", other: "Chief of Staff" }],
    ["reply", { me: SEATS[3], kind: "reply", other: "Projects Manager", speaker: "Projects Manager" }],
    ["back", { me: SEATS[1], kind: "back", back: { title: "The board", answer: "Done." } }],
    ["via-tool", { me: SEATS[4], kind: "answer", viaTool: true }],
  ];
  for (const [k, t] of turns) out[`turn:${k}`] = turnPrompt({ ...base, ...t } as TurnInput);
  out["pick:lead"] = answerPick(["what's left?"], SEATS)?.why ?? "";
  out["pick:mention"] = answerPick(["@ed check it"], SEATS)?.why ?? "";
  for (const lead of LEADS) out[`lead:${lead.id}`] = leadSoul(lead, `/work/${lead.projectId}`);
  out["lead:extra"] = leadSoul({ projectId: "shop", id: "shop-lead", name: "Shop lead", projectName: "Shop" }, null);
  out.checker = String(checkerRosterEntry().instructions);
  out.checkerRules = forUser(CHECKER_RULES); // as the checker's context reads it (monoFiles.ts)
  const primer = { project: "hub", name: "MonoCode Hub", text: "- Decision one", lines: 1, more: 3, memory_dir: "~/agent-memory/hub" };
  // No chat has memory tools since Ash OS is retired (WP-04): one block per reader.
  for (const worker of [true, false]) {
    out[`primer:${worker}`] = memoryPrimerBlock("hub", primer, { worker });
    out[`primer-missing:${worker}`] = memoryPrimerBlock("hub", undefined, { worker });
  }
  out.hubNote = hubNote();
  out.codingTeam = codingTeamContext({ projectId: "hub", projectName: "MonoCode Hub", folder: "/work/hub", leadName: "Hub lead" });
  out.noProjects = monoProjectsBrief({ projects: [] });
  out.namedMono = soulFromBrief({ name: "Scout", brief: "", connectors: [] }, "Marketing");
  out.handBack = handBackText("6 pm");
  out.dumpCheck = dumpCheck("s1", { id: "b1" } as never, ["the logo"]).prompt;
  const row = { id: "d1", title: "Fix it", childSession: "s2", ownerSession: "s1", status: "completed" } as unknown as Delegation;
  out.questionWake = JSON.stringify(questionWakeMessage(row, { requestId: "r1", questions: [{ question: "Which one?", prompt: "Which one?", options: [{ id: "o1", label: "A" }] }] } as never));
  out.reportRequest = reportRequest(row).text ?? "";
  return out;
}
