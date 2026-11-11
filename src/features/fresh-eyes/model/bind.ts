// WP-144: a reviewer is a new session with an empty history. It is not a builder.
// Local sessions only. Nothing here opens a network listener.

import {
  DEFAULT_RUNTIME_MODE,
  newSession,
  type HarnessId,
  type Session,
} from "../../sessions/model/session";
import { ReviewerTimeout, type ReviewerPort, type ReviewerTurn } from "./review";

export type FreshEyesHooks = {
  sessions(): readonly { id: string }[];
  add(session: Session): void;
  submit(
    sessionId: string,
    text: string,
    history: readonly [],
    options: { managed?: boolean; onSettled?: (outcome: { status?: string; text?: string; error?: string }) => void },
  ): Promise<boolean> | boolean;
  stop?(sessionId: string): void;
  remove?(sessionId: string): void;
  cwd: string | (() => string);
  /** How long one reviewer has to answer before it is stopped and counted as timed out. */
  timeoutMs?: number;
};

/** One reviewer's time. A session that never answers is stopped, and the review asks the person instead of waiting. */
export const REVIEWER_TIMEOUT_MS = 4 * 60_000;

const SESSION_MODEL: Record<string, { harness: HarnessId; model: string }> = {
  "claude-haiku-4-5": { harness: "claude", model: "claude:haiku-4.5" },
  "deepseek-v4-flash": { harness: "opencode", model: "deepseek-v4-flash" },
  "zai/glm-5.2-fast": { harness: "fx", model: "zai/glm-5.2-fast" },
};

let port: ReviewerPort | undefined;
let installedByBind = false;

export function setFreshEyesPort(next: ReviewerPort | undefined): void {
  port = next;
  installedByBind = false;
}

export function freshEyesPort(): ReviewerPort | undefined {
  return port;
}

function folder(cwd: FreshEyesHooks["cwd"]): string {
  const value = typeof cwd === "function" ? cwd() : cwd;
  return typeof value === "string" && value.trim() ? value.trim() : "~";
}

function sessionFor(turn: ReviewerTurn, cwd: string): Session {
  const mapped = turn.model ? SESSION_MODEL[turn.model] : undefined;
  const harness = mapped?.harness ?? "claude";
  const model = mapped?.model ?? turn.model ?? undefined;
  let session: Session;
  try {
    session = newSession(harness, cwd, model, DEFAULT_RUNTIME_MODE, { effort: turn.effort || "low" });
  } catch {
    throw new Error("The reviewer could not start.");
  }
  session.title = "Fresh-eyes review";
  session.blocks = [];
  session.modelSettings = { ...session.modelSettings, effort: turn.effort || "low" };
  return session;
}

/** One ask, then the session is stopped. A timeout is not a final failure. */
export function portFromHooks(hooks: FreshEyesHooks): ReviewerPort {
  return {
    async ask(turn) {
      const session = sessionFor(turn, folder(hooks.cwd));
      hooks.add(session);
      try {
        return await new Promise<string>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => finish(new ReviewerTimeout()), hooks.timeoutMs ?? REVIEWER_TIMEOUT_MS);
          const finish = (error?: Error, value?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value ?? "");
          };
          let started: Promise<boolean> | boolean;
          try {
            started = hooks.submit(session.id, turn.prompt, [], {
              managed: true,
              onSettled: (outcome) => {
                if (outcome.status === "completed") finish(undefined, outcome.text ?? "");
                else if (/timed out|timeout/i.test(outcome.error ?? "")) finish(new ReviewerTimeout());
                else finish(new Error(outcome.error || "The reviewer could not start."));
              },
            });
          } catch (error) {
            finish(error instanceof Error ? error : new Error("The reviewer could not start."));
            return;
          }
          const refused = (ok: boolean) => {
            if (!ok) finish(new Error("The reviewer could not start."));
          };
          if (started instanceof Promise) {
            void started.then(refused, (error: unknown) => {
              finish(error instanceof Error ? error : new Error("The reviewer could not start."));
            });
          } else {
            refused(started);
          }
        });
      } finally {
        try {
          hooks.stop?.(session.id);
        } catch {
          // A reviewer that never started has nothing to stop.
        }
        try {
          hooks.remove?.(session.id);
        } catch {
          // Leaving the session behind is not a pass.
        }
      }
    },
  };
}

/** Wire reviewers to the app's sessions. A port a test already set is left alone. */
export function bindFreshEyesApp(hooks: FreshEyesHooks): () => void {
  const had = port !== undefined;
  if (!had) {
    port = portFromHooks(hooks);
    installedByBind = true;
  }
  return () => {
    if (installedByBind) {
      port = undefined;
      installedByBind = false;
    }
  };
}
