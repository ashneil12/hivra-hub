// WP-23: each seat is a session on its own CLI, opened the same way the app opens any session. Nothing here launches a CLI.
import { formatLeadBrief } from "../../hub/model/leadershipDelegation";
import { getChat } from "../../hub/model/hubChats";
import { HARNESSES, newSession, type HarnessId, type Session } from "../../sessions/model/session";
import type { ControlOutcome } from "../../orchestration/model/orchestration";
import {
  councilModelInUse,
  installCouncilModel,
  setCouncilDelegator,
  setCouncilModel,
  setCouncilSeatHost,
  setCouncilSeatOpener,
  type CouncilSeatCall,
} from "./host";

export type CouncilAppHooks = {
  sessions(): readonly { id: string }[];
  add(session: Session): void;
  submit(
    sessionId: string,
    text: string,
    options: { managed?: boolean; onSettled?: (outcome: ControlOutcome) => void },
  ): Promise<boolean> | boolean;
  stop(sessionId: string): void;
  show(sessionId: string): void;
  /** A folder, or a function read when the seat is created (the app's home is not known at startup). */
  cwd: string | (() => string);
  hand(monoId: string, text: string): void;
};

function folder(cwd: CouncilAppHooks["cwd"]): string {
  const value = typeof cwd === "function" ? cwd() : cwd;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || "~";
}

function stopped(): DOMException {
  return new DOMException("The council was stopped.", "AbortError");
}

/**
 * Wire the council to the app's sessions. Returns a cleanup. The model is replaced only when this bind installed it,
 * so a test's stand-in model is left alone.
 */
export function bindCouncilApp(hooks: CouncilAppHooks): () => void {
  const ensure = (seat: CouncilSeatCall): string => {
    const existing = hooks.sessions().find((session) => session.id === seat.sessionId);
    if (existing) return existing.id;
    if (!(HARNESSES as readonly string[]).includes(seat.cli)) throw new Error("That seat has no CLI.");
    const created = newSession(seat.cli as HarnessId, folder(hooks.cwd), seat.model);
    const session: Session = { ...created, id: seat.sessionId, title: seat.label };
    hooks.add(session);
    return session.id;
  };

  const ask = (sessionId: string, prompt: string, signal: AbortSignal): Promise<{ text: string; tokens?: number }> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(stopped());
        return;
      }
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("The seat did not answer."));
      };
      const onAbort = () => {
        try {
          hooks.stop(sessionId);
        } catch {
          /* stopping a seat that never started still ends the ask */
        }
        fail(stopped());
      };
      signal.addEventListener("abort", onAbort);
      let started: boolean | Promise<boolean>;
      try {
        started = hooks.submit(sessionId, prompt, {
          managed: true,
          onSettled: (outcome) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            if (outcome.status === "completed") resolve({ text: outcome.text ?? "" });
            else reject(new Error(outcome.error || "The seat did not answer."));
          },
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error("The seat could not start."));
        return;
      }
      const refused = (ok: boolean) => {
        if (!ok) fail(new Error("The seat could not start."));
      };
      if (started instanceof Promise) {
        void started.then(refused, (error: unknown) => {
          fail(error instanceof Error ? error : new Error("The seat could not start."));
        });
      } else {
        refused(started);
      }
    });

  setCouncilSeatHost({ ensure, ask });
  const hadModel = councilModelInUse() !== undefined;
  if (!hadModel) installCouncilModel();
  const installed = !hadModel && councilModelInUse() !== undefined;

  setCouncilSeatOpener((seat) => {
    if (!seat.cli) {
      hooks.show(seat.sessionId);
      return;
    }
    try {
      const id = ensure({
        id: seat.id ?? seat.sessionId,
        cli: seat.cli,
        ...(seat.model ? { model: seat.model } : {}),
        sessionId: seat.sessionId,
        label: seat.label,
      });
      hooks.show(id);
    } catch {
      hooks.show(seat.sessionId);
    }
  });

  setCouncilDelegator((brief, _record, chatId) => {
    const monoId = getChat(chatId)?.memberIds.map((id) => id.trim()).find(Boolean);
    if (!monoId) return;
    hooks.hand(monoId, formatLeadBrief("the council", brief));
  });

  return () => {
    setCouncilSeatHost(undefined);
    setCouncilSeatOpener(undefined);
    setCouncilDelegator(undefined);
    if (installed) setCouncilModel(undefined);
  };
}
