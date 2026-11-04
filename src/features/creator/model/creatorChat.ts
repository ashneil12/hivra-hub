// WP-34. Build starts a chat with the Creator Mono. The brief carries the ask, the kind, the id and the revision.
// The production Build button does not write the plugin itself. draftFor stays a test stand-in.

import { addMono, findMono } from "../../monos/model/mono";
import { ensureMonoSession } from "../../monos/model/monoWorkspace";
import { enqueueMonoMessage } from "../../monos/model/monoMessaging";
import type { Session } from "../../sessions/model/session";
import { creatorStart, type CreatorState } from "./creator";
import type { ContributionKind } from "./draftFor";
import { CREATOR_BRIEF_EVENT, CREATOR_DRAFT_EVENT, CREATOR_MONO_ID } from "./creatorEvents";
// The bundled template's soul, read the way WP-05's starter Monos read theirs. It seeds the Mono's SOUL.md.
import creatorSoul from "../../../../src-tauri/plugins/hivra-creator/hivra/monos/creator/SOUL.md?raw";

export { CREATOR_BRIEF_EVENT, CREATOR_DRAFT_EVENT, CREATOR_MONO_ID };

export type CreatorSessionHost = {
  home: () => Promise<string>;
  load: (id: string) => Promise<Session | null | undefined>;
  create: (cwd: string) => Session;
  add: (session: Session) => void;
  update?: (session: Session) => void;
};

let registered: CreatorSessionHost | undefined;
let pendingBrief: { text: string; requestId: string } | null = null;

export function setCreatorSessionHost(host: CreatorSessionHost | undefined): () => void {
  registered = host;
  return () => {
    if (registered === host) registered = undefined;
  };
}

export function creatorBrief(input: { ask: string; kind: string; id: string; revision: number }): string {
  return [
    `Build a ${input.kind}.`,
    input.ask,
    `Creator id ${input.id}.`,
    `Revision ${input.revision}.`,
    "Write the files, then call app creator.draft with them, and read creator.state for the reports.",
  ].join("\n");
}

/** The Creator Mono, made once from the bundled template: its soul is the template's SOUL.md. */
function ensureCreatorMono(): void {
  if (findMono(CREATOR_MONO_ID)) return;
  const soul = creatorSoul.trim() ? (creatorSoul.endsWith("\n") ? creatorSoul : `${creatorSoul}\n`) : "";
  addMono({
    id: CREATOR_MONO_ID,
    name: "Creator",
    mascot: "robot",
    color: "hsl(200 40% 50%)",
    projects: [],
    // A role is a short label (40 characters at most), not the template's sentence.
    role: "Builds plugins",
    ...(soul ? { instructions: soul } : {}),
  });
}

function applyCreatorBrief(session: Session, brief: string, requestId: string): Session {
  if (session.queuedMessages?.some((message) => message.text === brief || message.appRequestId === requestId)) return session;
  if (session.blocks.some((block) => block.appRequestId === requestId)) return session;
  return enqueueMonoMessage(session, {
    id: requestId,
    text: brief,
    attachments: [],
    waitForIdle: true,
    appRequestId: requestId,
  });
}

function notify(name: string, detail: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

async function startCreatorChat(
  brief: string,
  detail: { ask: string; kind: string; id: string; revision: number; brief: string },
  host: CreatorSessionHost | undefined,
): Promise<string> {
  ensureCreatorMono();
  notify(CREATOR_BRIEF_EVENT, detail);
  const requestId = `creator-${detail.id}-r${detail.revision}`;
  const use = host ?? registered;
  if (!use) {
    pendingBrief = { text: brief, requestId };
    return "";
  }
  const session = await ensureMonoSession(CREATOR_MONO_ID, use);
  if (!session) {
    pendingBrief = { text: brief, requestId };
    return "";
  }
  const next = applyCreatorBrief(session, brief, requestId);
  if (next !== session) use.update?.(next);
  pendingBrief = null;
  return session.id;
}

/** A build that started before this window had a session host. Opening the Creator chat lands the brief. */
export function landCreatorBrief(session: Session): Session {
  if (!pendingBrief) return session;
  const next = applyCreatorBrief(session, pendingBrief.text, pendingBrief.requestId);
  if (next !== session) pendingBrief = null;
  return next;
}

export async function beginCreatorBuild(input: {
  kind: ContributionKind;
  ask: string;
  host?: CreatorSessionHost;
}): Promise<{ state: CreatorState; brief: string; sessionId: string }> {
  const state = await creatorStart(input.kind);
  const brief = creatorBrief({
    ask: input.ask,
    kind: input.kind,
    id: state.id,
    revision: state.revision,
  });
  const sessionId = await startCreatorChat(
    brief,
    { ask: input.ask, kind: input.kind, id: state.id, revision: state.revision, brief },
    input.host,
  );
  return { state, brief, sessionId };
}
