// Bench only (verifyDriver's teamPack op, dev copies with a verify plan): put the starter Monos on a fresh dev copy and
// seat them in one project's leadership room, so the behaviour benches have someone to talk to. A fresh copy offers
// those templates with none ticked (WP-05); this is the bench ticking all of them, the way first launch does, then
// writing Ash's souls and memory where those seeds still exist. A real launch does not call this.
import { addMonoProject, findMono, listMonos, monoWorksOn, updateMono } from "../../features/monos/model/mono";
import { defaultSoul, readAgentFile, writeAgentFile, type AgentFilePath } from "../../features/monos/model/monoFiles";
import { addMember, ensureLeadership } from "../../features/hub/model/hubChats";
import { seatedTeam } from "../../features/hub/model/hubTeam";
import { writeSoulFiles } from "../../features/hub/model/setupSouls";
import { addStarterMono, starterOffers } from "../../features/hub/model/starterMonos";
import { setTeamPack } from "../../features/hub/model/teamPack";
import { PLAIN_SOULS, TEAM_SOULS, teamMemorySeed } from "../../features/hub/model/teamSouls";

type Read = (monoId: string, path: AgentFilePath) => Promise<{ text: string | null; hash: string }>;
type Write = (monoId: string, path: AgentFilePath, text: string, expectedHash?: string) => Promise<unknown>;

/** `specId` is the starter template it came from, so a bench can pick a seat without matching on its name. */
export type BenchMono = { id: string; name: string; specId: string };
export type BenchTeam = { monos: BenchMono[]; wrote: string[] };

type BenchOpts = { project?: string; folder?: string; read?: Read; write?: Write };

const nameKey = (name: string | undefined) => (name ?? "").trim().toLowerCase();

/**
 * Adds every starter template that isn't already on the roster (matched by name, so a second call adds nothing), ties
 * each to the project (once), seats them in its leadership room, and writes Ash's soul and memory the way the old
 * pre-load did: only where a seed exists, and only over a soul that is still the app's. Returns the team, and the ids
 * whose soul file it wrote.
 *
 * `project` is the hub project's id: the room is named after it. `folder` is where that project's files are; a Mono has
 * to work on the folder, not the id, or a kickoff aimed at the folder never finds it (verifyKickoffMono), so that is
 * what each seat is tied to. No folder means the id is a folder (the shapes a person types into Settings are both).
 */
export async function benchAshTeam(readOrOpts?: Read | BenchOpts, writeArg?: Write): Promise<BenchTeam> {
  const opts: BenchOpts = typeof readOrOpts === "function" ? { read: readOrOpts, write: writeArg } : (readOrOpts ?? {});
  const read = opts.read ?? readAgentFile;
  const write = opts.write ?? writeAgentFile;
  setTeamPack("ash");

  const team: { id: string; name: string; specId: string }[] = [];
  for (const offer of starterOffers()) {
    const key = nameKey(offer.name);
    const existing = listMonos().find((mono) => nameKey(mono.name) === key);
    if (existing) {
      team.push({ id: existing.id, name: existing.name ?? offer.name, specId: offer.id });
      continue;
    }
    const created = addStarterMono(offer.id);
    if (!created?.id) continue;
    team.push({ id: created.id, name: created.name ?? offer.name, specId: offer.id });
  }

  const project = opts.project?.trim();
  const folder = (typeof opts.folder === "string" ? opts.folder.trim() : "") || project;
  if (project) {
    const room = ensureLeadership(project);
    for (const seat of team) addMember(room.id, seat.id);
  }
  if (folder) {
    for (const seat of team) {
      // WP-05 left nothing tied to a project (`tieTeamToProjects` reads the now-empty `seatedTeam`). A bench's Monos
      // have to work on the project it is about, or their kickoff never finds them (verifyKickoffMono).
      const mono = findMono(seat.id);
      if (mono && !monoWorksOn(mono, folder)) addMonoProject(seat.id, folder);
    }
  }

  const wrote: string[] = [];
  const seen = new Set<string>();
  for (const mono of team) {
    seen.add(mono.id);
    if (await writeAshFiles(mono.id, mono.specId, read, write)) wrote.push(mono.id);
  }
  // A Mono the old roster still recognises as a team seat, if one is ever seated that way again.
  for (const member of seatedTeam()) {
    if (seen.has(member.id)) continue;
    if (await writeAshFiles(member.id, member.specId, read, write)) wrote.push(member.id);
  }
  return { monos: team.map(({ id, name, specId }) => ({ id, name, specId })), wrote };
}

/**
 * Ash's soul over a file that is still missing, empty, or the plain seed; a soul someone wrote is kept. Memory is
 * written only where it is empty. Nothing is written when this spec has no Ash soul and no memory seed. Returns whether
 * the soul file was written.
 */
async function writeAshFiles(id: string, specId: string, read: Read, write: Write): Promise<boolean> {
  const ash = TEAM_SOULS[specId];
  const memory = teamMemorySeed(specId);
  if (!ash && !memory) return false;
  let current: string | null;
  try {
    current = (await read(id, "SOUL.md")).text;
  } catch {
    return false; // can't be read: left as it is
  }
  const seeded = [defaultSoul(), defaultSoul(PLAIN_SOULS[specId])].map((text) => text.trim());
  const untouched = current == null || seeded.includes(current.trim());
  let wroteSoul = false;
  if (ash) {
    const soul = await writeSoulFiles(id, [["SOUL.md", defaultSoul(ash)]], { read, write, replace: untouched });
    if (soul.written.length) {
      updateMono(id, (mono) => ({ ...mono, instructions: "" }));
      wroteSoul = true;
    }
  }
  if (memory) await writeSoulFiles(id, [["MEMORY.md", memory]], { read, write });
  return wroteSoul;
}
