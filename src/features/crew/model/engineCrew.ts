// A crew member the engine started itself (a T3 child conversation) gets a chat of its own under the first mate that
// started it, the same as one the first mate briefed through the app: a card on the turn that asked for it and a chat
// in the sidebar. The engine runs the member and hands its report back; the chat here only shows what it does.
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import type { QuickLaunch } from "../../quick-composer/model/quickComposer";
import type { Block, MonoSpawnedSession, Session } from "../../sessions/model/session";

export type EngineCrewStart = Extract<HarnessEvent, { type: "crew.started" }>;

export type EngineCrewChat = {
  /** The member's chat: it opens quietly, on its first mate's provider, model and permission mode. */
  launch: QuickLaunch;
  /** Its card on the first mate's turn. */
  card: MonoSpawnedSession;
  /** The first mate's turn that asked for it; none when its chat has no turn yet. */
  turnId?: string;
};

/**
 * The chat for a crew member the engine announced, or nothing when it already has one. `turns` is the first mate's
 * chat grouped into turns (`groupMonoTurns`); the card goes on the latest.
 */
export function engineCrewChat(
  owner: Pick<Session, "cwd" | "harness" | "model" | "modelSettings" | "runtimeMode">,
  start: EngineCrewStart,
  open: readonly Pick<Session, "id">[],
  turns: readonly (readonly Pick<Block, "id">[])[],
): EngineCrewChat | null {
  if (open.some((session) => session.id === start.sessionId)) return null;
  const title = start.title.trim() || "Crew member";
  return {
    launch: {
      prompt: start.brief.trim() || title,
      title,
      cwd: owner.cwd,
      harness: owner.harness,
      model: owner.model,
      ...(owner.modelSettings ? { modelSettings: owner.modelSettings } : {}),
      ...(owner.runtimeMode ? { runtimeMode: owner.runtimeMode } : {}),
      reveal: false,
    },
    card: { sessionId: start.sessionId, cwd: owner.cwd, title, harness: owner.harness, model: owner.model },
    turnId: turns[turns.length - 1]?.[0]?.id,
  };
}
