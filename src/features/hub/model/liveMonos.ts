// r66 (Alfred A6, 0.16.5): four minutes after Postie was retired, Chief of Staff listed it as "already up", then said it
// "stays in the sidebar until you hit Undo". Its picture of the team came from memory and the conversation. Every turn
// it now reads the live roster (retired Monos are off it), keyed on its id, never its name.
import { listMonos, monoLook } from "../../monos/model/mono";
import { retiredMonoIds } from "./hubConnectors";

export const COS_MONO_ID = "chief-of-staff";
/** The hub's read-only checker (hubMcp.CHECKER_MONO_ID): not a team member Ash talks about. */
const CHECKER_ID = "checker";

/** The live Mono list for this turn, for Chief of Staff only (undefined for any other Mono). */
export function liveMonosNote(forMonoId: string | undefined): string | undefined {
  if (forMonoId !== COS_MONO_ID) return undefined;
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
