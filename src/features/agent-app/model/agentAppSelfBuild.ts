// The app side of the tools that make things with Ash (`monocode` MCP: mono_create, page_build, hub_change,
// skills_learn): a new Mono (step 13), a Page (step 14), a change to the hub itself (step 15) and a lesson a worker's
// self-review taught a skill (step 16). Each shows Ash first and goes in on his yes, except a lesson, which applies at
// once with Undo in Bot changes; the checks live here and in Rust, not in the Mono's prompt.
import type { Session } from "../../sessions/model/session";
import { allChats } from "../../hub/model/hubChats";
import { loadSkills } from "../../skills/model/skills";
import { askedAshAndHeardBack, ashSpokeSince, INTERVIEW_FIRST } from "../../selfBuild/model/ashSaid";
import { hubChangeBrief, readyHubChange, startHubChange, undoHubPart } from "../../selfBuild/model/hubCode";
import { draftMono, makeDrafted } from "../../selfBuild/model/monoMake";
import { keepFromChat, previewFromChat } from "../../selfBuild/model/pagesChat";
import { learnSkillLesson } from "../../selfBuild/model/skillLearn";
import { applyTodayFromChat, todayFromChat } from "../../selfBuild/model/todayChat";
import type { AgentAppHost } from "./agentApp";
import { resolveRoom, teamLeadOf } from "./agentAppRooms";
import { forUser } from "../../hub/model/userName";
import { roomTurnOf } from "../../hub/model/roomConductor";

export const SELF_BUILD_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["monos.create", ["name", "role", "who", "watchFor", "soul", "skills", "projects", "connectors", "rooms", "draftId"]],
  ["pages.build", ["project", "spec", "request", "previewId", "keep"]],
  ["hub.change", ["ask", "title", "changeId", "ready", "undo"]],
  ["today.change", ["ask", "projectOrder", "previewId", "apply"]],
  ["skills.learn", ["skill", "lesson", "from"]],
];

/** Hands the change to a Claude Code worker in the preview copy (tasks.delegate, run in that folder). */
export type DelegateInFolder = (brief: string, title: string, folder: string) => Promise<unknown>;

function seated(source: Session, host: AgentAppHost) {
  const mono = host.isMono(source.id) && !host.isHabitRun?.(source.id) ? host.monoOf?.(source.id) : undefined;
  if (!mono) {
    // A coding-team chat passes it to its Lead itself, never sending Ash to another chat (Board 22 Oct, run d91c AD14).
    const team = host.codingTeamOf?.(source.id);
    const lead = team ? teamLeadOf(team.project) : undefined;
    if (team && lead)
      throw new Error(
        forUser`A coding-team chat can't do this itself; ${lead.name} can. Hand Ash's ask to ${lead.name} with mono_message (to "${lead.id}"), in his words, then tell him in one line that ${lead.name} has it. Don't send him to another chat.`,
      );
    throw new Error("Only one of your own Monos, in its own chat, can do this. Temporary workers can't.");
  }
  return { monoId: mono.id, name: mono.name ?? mono.id, projects: mono.projects };
}

/** The skills that really exist for this Mono: its engine's catalog in its folder (the composer's / list). */
async function installedSkills(source: Session, host: AgentAppHost): Promise<ReadonlySet<string>> {
  if (host.installedSkills) return new Set(await host.installedSkills());
  const list = await loadSkills({ harness: source.harness, cwd: source.cwd });
  return new Set(list.filter((s) => s.kind !== "builtin").map((s) => s.name));
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
      if (!askedAshAndHeardBack(source, me.monoId, allChats())) throw new Error(forUser(INTERVIEW_FIRST));
      // Its card goes in the chat it was drafted in: the group chat the Mono is answering in, else its own chat (r29).
      const turn = roomTurnOf(me.monoId);
      const where = turn ? { room: turn.chatId, conv: turn.convId } : { session: source.id };
      return draftMono(input, me, Date.now(), await installedSkills(source, host), where);
    }
    case "pages.build": {
      if (input.previewId !== undefined || input.keep !== undefined) {
        if (input.keep !== true) throw new Error("keep must be true, with previewId");
        return keepFromChat(input.previewId, me, spoke);
      }
      return previewFromChat(input, me);
    }
    case "today.change": {
      if (input.previewId !== undefined || input.apply !== undefined) {
        if (input.apply !== true) throw new Error("apply must be true, with previewId");
        return applyTodayFromChat(input.previewId, me, spoke);
      }
      return todayFromChat(input, me);
    }
    case "hub.change": {
      if (typeof input.undo === "string") return undoHubPart(input.undo);
      if (typeof input.changeId === "string") {
        if (input.ready !== true) throw new Error("Call with changeId and ready true once the worker's report is back.");
        return readyHubChange(input.changeId, me.name);
      }
      if (typeof input.ask !== "string" || !input.ask.trim()) throw new Error(forUser("ask must be Ash's words for the change"));
      const title = typeof input.title === "string" ? input.title : undefined;
      const { changeId, folder } = await startHubChange(input.ask.trim(), title, me.name);
      const task = await delegate(hubChangeBrief(input.ask.trim(), folder), title ?? "Change the hub", folder);
      return {
        changeId,
        task,
        note: forUser("A Claude Code worker is making it in a preview copy; your live hub is unchanged. Tell Ash in one line and end your turn. When its report comes back, call hub_change with changeId and ready true."),
      };
    }
    case "skills.learn": {
      if (typeof input.skill !== "string" || !input.skill.trim())
        throw new Error('skill must be the skill\'s name, like "reviewing-a-diff".');
      if (typeof input.lesson !== "string" || !input.lesson.trim())
        throw new Error(forUser("lesson must be the one plain sentence worth keeping from that review."));
      return learnSkillLesson({
        skill: input.skill,
        lesson: input.lesson,
        from: typeof input.from === "string" ? input.from : undefined,
        by: me.name,
      });
    }
    default:
      throw new Error(`Unknown action ${action}`);
  }
}
