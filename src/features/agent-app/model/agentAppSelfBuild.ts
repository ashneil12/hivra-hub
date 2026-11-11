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
import { handleMonoRetire } from "../../selfBuild/model/monoRetire";
import { draftTeam, makeDraftedTeam } from "../../selfBuild/model/teamMake";
import { keepFromChat, previewFromChat } from "../../selfBuild/model/pagesChat";
import { realSkillPorts, routeSkillLesson } from "../../selfBuild/model/skillRoute";
import { applyTodayFromChat, todayFromChat } from "../../selfBuild/model/todayChat";
import { creatorDraft, creatorState } from "../../creator/model/creator";
import { CREATOR_DRAFT_EVENT } from "../../creator/model/creatorEvents";
import type { AgentAppHost } from "./agentApp";
import { resolveRoom, teamLeadOf } from "./agentAppRooms";
import { forUser } from "../../hub/model/userName";
import { roomTurnOf } from "../../hub/model/roomConductor";

export const SELF_BUILD_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["monos.create", ["name", "role", "who", "watchFor", "soul", "skills", "projects", "connectors", "rooms", "draftId"]],
  ["monos.retire", ["mono", "retireId"]],
  ["teams.create", ["name", "brief", "projects", "members", "draftId"]],
  ["pages.build", ["project", "spec", "request", "previewId", "keep"]],
  ["hub.change", ["ask", "title", "changeId", "ready", "undo"]],
  ["today.change", ["ask", "projectOrder", "previewId", "apply"]],
  ["skills.learn", ["skill", "lesson", "from", "replace"]],
  // WP-34: draft and state only. Preview, keep, undo, discard, approve and probe stay taps.
  ["creator.draft", ["id", "revision", "files"]],
  ["creator.state", ["id"]],
];

/** Hands the change to a Claude Code worker in the preview copy (tasks.delegate, run in that folder). */
/** Hivra WP-10: `intent` is Ash's own ask, which every brief carries (firstmate/model/brief.ts). */
export type DelegateInFolder = (brief: string, title: string, folder: string, intent: string) => Promise<unknown>;

function creatorSessionId(input: Record<string, unknown>): string {
  if (typeof input.id !== "string" || input.id.trim() === "") throw new Error("id must be the creator session.");
  return input.id;
}

function creatorFiles(input: Record<string, unknown>): { path: string; content: string }[] {
  if (!Array.isArray(input.files) || input.files.length === 0) throw new Error("There's nothing to write.");
  return input.files.map((file) => {
    if (typeof file !== "object" || file === null) throw new Error("There's nothing to write.");
    const row = file as Record<string, unknown>;
    if (typeof row.path !== "string" || typeof row.content !== "string") throw new Error("There's nothing to write.");
    return { path: row.path, content: row.content };
  });
}

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
    case "monos.retire":
      return handleMonoRetire(input, me, { ashSpokeSince: spoke });
    case "teams.create": {
      if (input.draftId !== undefined) {
        if (Object.keys(input).length > 1) throw new Error("With draftId, send nothing else: the draft is what gets made.");
        return makeDraftedTeam(input.draftId, me, { ashSpokeSince: spoke });
      }
      // Its card goes in the chat it was drafted in, like a Mono's (the group chat it is answering in, else its own).
      const turn = roomTurnOf(me.monoId);
      const where = turn ? { room: turn.chatId, conv: turn.convId } : { session: source.id };
      return draftTeam(input, me, Date.now(), where);
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
      const task = await delegate(hubChangeBrief(input.ask.trim(), folder), title ?? "Change the hub", folder, input.ask.trim());
      return {
        changeId,
        task,
        note: forUser("A Claude Code worker is making it in a preview copy; your live hub is unchanged. Tell Ash in one line and end your turn. When its report comes back, call hub_change with changeId and ready true."),
      };
    }
    case "creator.draft": {
      const id = creatorSessionId(input);
      if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 0) {
        throw new Error("revision must be the creator session's revision.");
      }
      const files = creatorFiles(input);
      const drafted = await creatorDraft(id, input.revision, files);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(CREATOR_DRAFT_EVENT, { detail: drafted }));
      }
      return drafted;
    }
    case "creator.state":
      return creatorState(creatorSessionId(input));
    case "skills.learn": {
      if (typeof input.skill !== "string" || !input.skill.trim())
        throw new Error('skill must be the skill\'s name, like "reviewing-a-diff".');
      if (typeof input.lesson !== "string" || !input.lesson.trim())
        throw new Error(forUser("lesson must be the one plain sentence worth keeping from that review."));
      if (input.replace !== undefined && (typeof input.replace !== "string" || !input.replace.trim()))
        throw new Error("replace must be the exact lesson to change, as it is in the skill.");
      // WP-242: Automatic, Ask first or Off, as set in Settings → Memory; every lesson is cleaned first.
      return routeSkillLesson(
        {
          skill: input.skill,
          lesson: input.lesson,
          ...(typeof input.from === "string" ? { from: input.from } : {}),
          ...(typeof input.replace === "string" ? { replace: input.replace } : {}),
        },
        me,
        host.skillRoute ?? realSkillPorts(),
      );
    }
    default:
      throw new Error(`Unknown action ${action}`);
  }
}
