// Putting a restored Mono back on the rail. The files are already back: this only
// repairs the roster. A bad payload is ignored. A team folder that can't be made
// yet is not a reason to undo the restore.

import { clearMonoRemovedByUser } from "../../hub/model/builtInMonos";
import { ensureMonoTeam } from "../../hub/model/monoTeams";
import { addMono, type Mono } from "../../monos/model/mono";
import { readPayload } from "./trash";

export async function restoreMonoRoster(id: string, payload: string): Promise<void> {
  const value = readPayload(payload);
  if (value) addMono(value as Mono);
  const name = value && typeof value.name === "string" ? value.name : undefined;
  clearMonoRemovedByUser(id, name);
  await ensureMonoTeam(id).catch(() => undefined);
}
