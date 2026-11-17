// The engine's ids as this app can keep them. A saved chat keeps only ids made of letters, digits, "-" and "_"
// (persistableId.ts); the engine's runs ("run:thread:...") and crew conversations ("thread:subagent:...") have colons,
// so without this a chat would forget them at every relaunch and could not pick a turn back up.
import { isPersistableId } from "../../../../features/sessions/model/persistableId";

const WRAPPED = "t3x_";

/** The id the chat is given for one of the engine's. */
export function t3AppId(id: string): string {
  if (isPersistableId(id) && !id.startsWith(WRAPPED)) return id;
  try {
    return WRAPPED + btoa(id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return id;
  }
}

/** The engine's own id for one the chat kept. */
export function t3EngineId(id: string): string {
  if (!id.startsWith(WRAPPED)) return id;
  try {
    return atob(id.slice(WRAPPED.length).replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return id;
  }
}

/**
 * The chat a crew member the engine started gets: the app's own name for a chat another chat started
 * (`app-<that chat>-<request>`), so every screen and check treats it as a worker under its first mate. Its brief is
 * then never read as Ash's asks and it is sent no check of its own. A first mate whose id can't be kept gets a bare id.
 */
export function crewChatId(owner: string, request: string): string {
  return isPersistableId(owner) && isPersistableId(request) ? `app-${owner}-${request}` : request;
}
