// Dropwave (Ash, 11 Nov): "if you're under Home and you click on Chief of Staff, it doesn't show that you're selected on
// Home still ... it's like some of the things disappear". Home is a place of its own: its screen, and the chat of a
// first mate that works on no project (the Chief of Staff) opened from it. The project Ash was last in stays underneath
// (leaving Home comes back to it), but nothing of that project shows while Home is in view.
import { findMono, listMonos } from "../../monos/model/mono";
import { pickChief } from "../../home/model/chief";
import { monoTeamInView, type HubSelection } from "./hubNav";

/**
 * The Chief of Staff's own chat (or a first mate on no project) is the open thing. The Chief of Staff counts whatever
 * projects it is on: onboarding puts it on every project, and its chats opened from Home are still Home's (Ash, 12 Nov:
 * "the home area is almost like its own project"). A project's own Chief of Staff chat opens inside that project's
 * coding team, never as this item, so it stays the project's.
 */
export function homeChatInView(sel: Pick<HubSelection, "item">): boolean {
  const id = monoTeamInView(sel as HubSelection);
  if (!id) return false;
  if (id === pickChief(listMonos())?.id) return true;
  return (findMono(id)?.projects.length ?? 1) === 0;
}

/** Home's screen, or the Chief of Staff's chat opened from it. */
export function homeInView(sel: Pick<HubSelection, "item">): boolean {
  return sel.item === "home" || homeChatInView(sel);
}
