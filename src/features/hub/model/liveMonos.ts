// Every turn reads the live roster (retired Monos are off it), keyed on id, never on a name. No Mono is special.
import { listMonos, monoLook } from "../../monos/model/mono";
import { retiredMonoIds } from "./hubConnectors";

/** The hub's read-only checker (hubMcp.CHECKER_MONO_ID): not a team member. */
const CHECKER_ID = "checker";

/** The live Mono list for this turn. Undefined when there is no Mono. */
export function liveMonosNote(forMonoId: string | undefined): string | undefined {
  if (!forMonoId) return undefined;
  const retired = new Set(retiredMonoIds());
  const monos = listMonos().filter((m) => m.id !== CHECKER_ID && !retired.has(m.id));
  const lines = monos.map((m) => {
    const look = monoLook(m);
    return `- ${look.name}${m.id === forMonoId ? " (you)" : ""}${look.role ? `: ${look.role}` : ""}`;
  });
  return `<monos_now>
The Monos on the team right now, read live for this turn (${monos.length}):
${lines.join("\n")}
Only these exist now. One that isn't listed was retired or never made: never say it is up, in the sidebar or waiting on an Undo, and never hand it work.
</monos_now>`;
}
