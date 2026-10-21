// Bench only (verifyDriver's teamPack op, dev copies with a verify plan): put Ash's own team on a fresh dev copy, so
// realconv scenes play his Monos. The app itself has no pre-load since PM round 19 (Ash 21 Oct: his team arrives by
// importing his export); this is the bench's stand-in for that import, written the way an import writes a Mono's files.
import { updateMono } from "../../features/monos/model/mono";
import { defaultSoul, readAgentFile, writeAgentFile, type AgentFilePath } from "../../features/monos/model/monoFiles";
import { seatedTeam } from "../../features/hub/model/hubTeam";
import { writeSoulFiles } from "../../features/hub/model/setupSouls";
import { setTeamPack } from "../../features/hub/model/teamPack";
import { PLAIN_SOULS, TEAM_SOULS, teamMemorySeed } from "../../features/hub/model/teamSouls";

type Read = (monoId: string, path: AgentFilePath) => Promise<{ text: string | null; hash: string }>;
type Write = (monoId: string, path: AgentFilePath, text: string, expectedHash?: string) => Promise<unknown>;

/**
 * Ash's souls over the fresh install's, where a soul is still as the app seeded it (missing, the empty stub or the
 * plain one); a soul someone wrote is kept. Memory is written only where it is empty. Returns the ids whose soul it wrote.
 */
export async function benchAshTeam(read: Read = readAgentFile, write: Write = writeAgentFile): Promise<string[]> {
  setTeamPack("ash");
  const wrote: string[] = [];
  for (const { id, specId } of seatedTeam()) {
    let current: string | null;
    try {
      current = (await read(id, "SOUL.md")).text;
    } catch {
      continue; // can't be read: left as it is
    }
    const seeded = [defaultSoul(), defaultSoul(PLAIN_SOULS[specId])].map((t) => t.trim());
    const untouched = current == null || seeded.includes(current.trim());
    const soul = await writeSoulFiles(id, [["SOUL.md", defaultSoul(TEAM_SOULS[specId])]], { read, write, replace: untouched });
    const memory = teamMemorySeed(specId);
    if (memory) await writeSoulFiles(id, [["MEMORY.md", memory]], { read, write });
    if (soul.written.length) {
      updateMono(id, (mono) => ({ ...mono, instructions: "" }));
      wrote.push(id);
    }
  }
  return wrote;
}
