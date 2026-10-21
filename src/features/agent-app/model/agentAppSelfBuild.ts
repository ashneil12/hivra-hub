// The app side of the tools that make things with Ash (`monocode` MCP: mono_create, page_build, hub_change): a new
// Mono (step 13), a Page (step 14) and a change to the hub itself (step 15). Each shows Ash first and goes in on his
// yes; the checks live here and in Rust, not in the Mono's prompt.
import type { Session } from "../../sessions/model/session";
import { allChats } from "../../hub/model/hubChats";
import { ashSpokeSince } from "../../selfBuild/model/ashSaid";
import { hubChangeBrief, readyHubChange, startHubChange, undoHubPart } from "../../selfBuild/model/hubCode";
import { draftMono, makeDrafted } from "../../selfBuild/model/monoMake";
import { keepFromChat, previewFromChat } from "../../selfBuild/model/pagesChat";
import type { AgentAppHost } from "./agentApp";
import { resolveRoom } from "./agentAppRooms";

export const SELF_BUILD_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["monos.create", ["name", "role", "who", "watchFor", "soul", "skills", "projects", "connectors", "rooms", "draftId"]],
  ["pages.build", ["project", "spec", "request", "previewId", "keep"]],
  ["hub.change", ["ask", "title", "changeId", "ready", "undo"]],
];

/** Hands the change to a Claude Code worker in the preview copy (tasks.delegate, run in that folder). */
export type DelegateInFolder = (brief: string, title: string, folder: string) => Promise<unknown>;

function seated(source: Session, host: AgentAppHost) {
  const mono = host.isMono(source.id) && !host.isHabitRun?.(source.id) ? host.monoOf?.(source.id) : undefined;
  if (!mono) throw new Error("Only a seated Mono, in its own chat, can do this. Temporary workers can't.");
  return { monoId: mono.id, name: mono.name ?? mono.id, projects: mono.projects };
}

export async function handleSelfBuild(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
  delegate: DelegateInFolder,
): Promise<unknown> {
  const me = seated(source, host);
  const spoke = (since: number) => ashSpokeSince(source, me.monoId, since, allChats());
  switch (action) {
    case "monos.create": {
      if (input.draftId !== undefined) {
        if (Object.keys(input).length > 1) throw new Error("With draftId, send nothing else: the draft is what gets made.");
        return makeDrafted(input.draftId, me, { ashSpokeSince: spoke, room: (ref) => resolveRoom(ref, me.monoId) });
      }
      return draftMono(input, me);
    }
    case "pages.build": {
      if (input.previewId !== undefined || input.keep !== undefined) {
        if (input.keep !== true) throw new Error("keep must be true, with previewId");
        return keepFromChat(input.previewId, me, spoke);
      }
      return previewFromChat(input, me);
    }
    case "hub.change": {
      if (typeof input.undo === "string") return undoHubPart(input.undo);
      if (typeof input.changeId === "string") {
        if (input.ready !== true) throw new Error("Call with changeId and ready true once the worker's report is back.");
        return readyHubChange(input.changeId, me.name);
      }
      if (typeof input.ask !== "string" || !input.ask.trim()) throw new Error("ask must be Ash's words for the change");
      const title = typeof input.title === "string" ? input.title : undefined;
      const { changeId, folder } = await startHubChange(input.ask.trim(), title, me.name);
      const task = await delegate(hubChangeBrief(input.ask.trim(), folder), title ?? "Change the hub", folder);
      return {
        changeId,
        task,
        note: "A Claude Code worker is making it in a preview copy; your live hub is unchanged. Tell Ash in one line and end your turn. When its report comes back, call hub_change with changeId and ready true.",
      };
    }
    default:
      throw new Error(`Unknown action ${action}`);
  }
}
