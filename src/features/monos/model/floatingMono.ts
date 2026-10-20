import type { ApprovalDecision } from "../../../integrations/harness";
import type {
  Attachment,
  HarnessId,
  Session,
} from "../../sessions/model/session";
import type { UserQuestionReply } from "../../sessions/model/userQuestion";
import { displayAttachments } from "../../sessions/model/attachments";
import { listMonos, monoLook, monoState, type MonoStatus } from "./mono";
import { pixelLayers } from "../../projects/model/pixelMascots";
import type { StopTreeResult } from "./stopTree";

export const FLOATING_MONO_CHANGED = "mono_chat_changed";
export const FLOATING_MONO_REQUEST = "mono_chat_request";
export type FloatingMonoEntry = {
  id: string;
  name: string;
  mascot: string;
  color: string;
  sessionId: string | null;
  status: MonoStatus;
};
export type FloatingMonoView = {
  monos: FloatingMonoEntry[];
  monoId: string | null;
  session: Session | null;
  error: string | null;
};
export type FloatingMonoAction =
  | { kind: "open" }
  | { kind: "submit"; text: string; attachments: Attachment[] }
  | { kind: "stop" }
  /** The Stop on a workflow run's row: that run and every agent in it. */
  | { kind: "stopWorkflow"; taskId: string }
  /** "Waiting on N" · Stop all: everything the Mono delegated. */
  | { kind: "stopAll" }
  /** The Stop on one task of a delegated batch: it and everything beneath it. */
  | { kind: "stopRow"; childSession: string }
  | { kind: "create" }
  | { kind: "approval"; requestId: number; decision: ApprovalDecision }
  | { kind: "question"; requestId: number; reply: UserQuestionReply }
  | { kind: "questionInteraction"; requestId: number }
  | { kind: "reveal" }
  | { kind: "openFile"; path: string }
  | { kind: "openArtifact"; id: string }
  | { kind: "resume" };
export type FloatingMonoRequest = {
  id: number;
  monoId: string;
  action: FloatingMonoAction;
};

export function floatingMonoRoster(
  enabled: boolean,
  sessions: readonly Session[] = [],
): FloatingMonoEntry[] {
  return enabled
    ? listMonos().map((mono) => {
        const session = sessions.find((s) => s.id === mono.sessionId);
        return {
          id: mono.id,
          ...monoLook(mono),
          sessionId: mono.sessionId ?? null,
          status: session ? monoState(session).status : "idle",
        };
      })
    : [];
}

/** Draw the same portraits in AppKit without a second set of mascot assets. */
export function floatingMonoMenuMascots(monos: FloatingMonoEntry[]) {
  return monos.map((mono) => {
    const { body, open } = pixelLayers(mono.mascot, mono.color);
    return { monoId: mono.id, rects: [...body, ...open] };
  });
}

/** Blob URLs belong to their webview; send attachment bytes/paths instead. */
export function floatingMonoSession(session: Session): Session {
  return {
    ...session,
    blocks: session.blocks.map((block) =>
      block.attachments?.length
        ? { ...block, attachments: floatingMonoAttachments(block.attachments) }
        : block,
    ),
    queuedMessages: session.queuedMessages?.map((message) => ({
      ...message,
      attachments: floatingMonoAttachments(message.attachments),
    })),
  };
}

export function floatingMonoAttachments(
  attachments: Attachment[],
): Attachment[] {
  return displayAttachments(attachments).map(
    ({ previewUrl: _preview, ...file }) => file,
  );
}

export type FloatingMonoHost = {
  open(monoId: string): Promise<Session | undefined>;
  submit(
    sessionId: string,
    text: string,
    attachments: Attachment[],
  ): boolean | void;
  stop(sessionId: string): void;
  /** The main chat's workflow Stop (AgentTranscript's onStopWorkflow). */
  stopWorkflow?(
    sessionId: string,
    harness: HarnessId,
    taskId: string,
  ): Promise<unknown> | void;
  /** The main chat's Stop all (useDelegationPane's onStopAll). */
  stopTree?(sessionId: string): Promise<StopTreeResult>;
  /** The main chat's Stop on a batch row (DelegationBatchRow), for a task this chat owns. */
  stopRow?(sessionId: string, childSession: string): Promise<StopTreeResult>;
  approval(
    sessionId: string,
    requestId: number,
    decision: ApprovalDecision,
  ): void;
  question(
    sessionId: string,
    requestId: number,
    reply: UserQuestionReply,
  ): void;
  questionInteraction(sessionId: string, requestId: number): void;
  reveal(monoId: string): Promise<void>;
  openFile(path: string): void | Promise<void>;
  openArtifact?(monoId: string, id: string): void | Promise<void>;
  resume(sessionId: string): void;
  /** Add a Mono and show it in place of the chat that asked. */
  create?(fromMonoId: string): Promise<void>;
};

/** Preparation may await disk; recheck the receipt before mutating a session. */
export async function deliverFloatingMonoRequest(
  request: FloatingMonoRequest,
  host: FloatingMonoHost,
  accept: () => Promise<boolean>,
): Promise<Session | undefined> {
  const session = await host.open(request.monoId);
  if (!session) throw new Error("That Mono is no longer available.");
  if (!(await accept())) return undefined;
  const action = request.action;
  switch (action.kind) {
    case "open":
      break;
    case "submit":
      if (host.submit(session.id, action.text, action.attachments) === false)
        throw new Error(
          "The message could not be sent. Try again in a moment.",
        );
      break;
    case "stop":
      host.stop(session.id);
      break;
    case "stopWorkflow":
      if (!host.stopWorkflow) throw new Error("Stopping a workflow is unavailable here.");
      // false: the adapter had nothing to stop. Say so, or the pop-out's Stop reads "Stopping…" for good.
      if ((await host.stopWorkflow(session.id, session.harness, action.taskId)) === false)
        throw new Error("Couldn't stop it: Claude Code isn't running this workflow any more.");
      break;
    case "stopAll":
      if (!host.stopTree) throw new Error("Stopping delegated work is unavailable here.");
      couldNotStop(await host.stopTree(session.id));
      break;
    case "stopRow":
      if (!host.stopRow) throw new Error("Stopping delegated work is unavailable here.");
      couldNotStop(await host.stopRow(session.id, action.childSession));
      break;
    case "approval":
      host.approval(session.id, action.requestId, action.decision);
      break;
    case "question":
      host.question(session.id, action.requestId, action.reply);
      break;
    case "questionInteraction":
      host.questionInteraction(session.id, action.requestId);
      break;
    case "reveal":
      await host.reveal(request.monoId);
      break;
    case "openFile":
      await host.openFile(action.path);
      break;
    case "openArtifact":
      if (!host.openArtifact) throw new Error("Artifacts are unavailable.");
      await host.openArtifact(request.monoId, action.id);
      break;
    case "resume":
      host.resume(session.id);
      break;
    case "create":
      if (!host.create) throw new Error("New Monos are unavailable here.");
      await host.create(request.monoId);
      break;
    default:
      throw new Error("Unknown chat action.");
  }
  return session;
}

/** A Stop that left chats running says so in the floating chat, as the main chat's line does. */
function couldNotStop(result: StopTreeResult): void {
  const count = result.stopFailed.length;
  if (count)
    throw new Error(
      count === 1 ? "Couldn't stop one chat." : `Couldn't stop ${count} chats.`,
    );
}
