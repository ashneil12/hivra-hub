// What a Stuck row on Today says before its title (Ash, 20 Oct): the project, then the Mono that answers for the work
// ("Hivra · Chief of Staff · Write the welcome email"). A project Lead is named for its project ("EXO lead"), so the
// project goes when the Mono's name already carries it: "EXO lead · Run the movement tests", not "EXO · EXO lead · ...".

/** What a project is called: its name, and the short name its Lead is named for ("Hub lead" for "MonoCode Hub"). */
export type ProjectNames = { name: string; shortName?: string };

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Whether `name` says `part` in whole words, in any case: "EXO lead" carries "EXO"; "Hubert" doesn't carry "Hub". */
function carries(name: string, part: string): boolean {
  const have = wordsOf(name);
  const want = wordsOf(part);
  if (!want.length) return false;
  for (let from = 0; from + want.length <= have.length; from += 1) {
    if (want.every((word, i) => have[from + i] === word)) return true;
  }
  return false;
}

/** The project's name to show before a Mono's, or nothing when the Mono's own name already carries it. */
export function projectBefore(project: ProjectNames | null | undefined, monoName: string): string | undefined {
  const name = project?.name.trim();
  if (!project || !name) return undefined;
  if (carries(monoName, name)) return undefined;
  if (project.shortName && carries(monoName, project.shortName)) return undefined;
  return name;
}

/** "EXO lead" for a Lead named for its project; "Hivra · Chief of Staff" for a Mono that isn't. */
export function stuckWhere(project: ProjectNames | null | undefined, monoName: string): string {
  return [projectBefore(project, monoName), monoName].filter(Boolean).join(" · ");
}
