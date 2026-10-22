// Skills that ship with the hub and install as real files with one tap.
//
// A skill only reaches an agent when it sits in a folder the harness scans (`skills.rs`): a project's
// `.agents/skills`, or the user's `~/.agents/skills`. Ready-made skills install into the user's folder, the same
// place `learnSkillLesson` writes (`selfBuild/model/skillLearn.ts`), so every project's Monos get them.
import findComponents from "../../../../.agents/skills/find-components/SKILL.md?raw";
import { invalidateProjectFiles } from "../../files/model/fileIndex";
import { joinPath } from "../../../shared/lib/paths";
import {
  createPath,
  homeDir,
  writeTextFile,
  type DiscoveredSkill,
} from "../../../platform/tauri/fs";
import { invalidateSkills } from "./skills";

export type ReadySkill = {
  id: string;
  name: string;
  title: string;
  what: string;
  markdown: string;
};

export const READY_SKILLS: ReadySkill[] = [
  {
    id: "find-components",
    name: "find-components",
    title: "Find components",
    what: "Reuse a good open-source component (calendar, chart, table) and restyle it to the hub's theme tokens, instead of building it from scratch. Installs for you, so every project's Monos get it.",
    markdown: findComponents,
  },
];

/** Whether a ready-made skill is already on disk (any scope counts: first name wins in the scan). */
export function readySkillInstalled(
  skills: DiscoveredSkill[],
  id: string,
): boolean {
  const ready = READY_SKILLS.find((item) => item.id === id);
  return ready ? skills.some((skill) => skill.name === ready.name) : false;
}

export async function installReadySkill(input: {
  cwd: string;
  id: string;
}): Promise<string> {
  const ready = READY_SKILLS.find((item) => item.id === input.id);
  if (!ready) throw new Error("That skill isn't one of the ready-made ones.");
  const root = await homeDir();
  const relative = `.agents/skills/${ready.name}`;
  await createPath(root, relative, true);
  const path = joinPath(root, `${relative}/SKILL.md`);
  await writeTextFile(path, ready.markdown);
  invalidateSkills({ cwd: input.cwd });
  invalidateProjectFiles(input.cwd);
  return path;
}
