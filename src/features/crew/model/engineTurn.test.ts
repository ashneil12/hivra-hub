import { describe, expect, it } from "vitest";
import { engineTurnOf } from "../../../integrations/harness/providers/t3/t3Outside";
import { briefView } from "../../sessions/model/briefView";
import type { Block } from "../../sessions/model/session";
import { engineTurnFor } from "./engineTurn";

const sender = (sessionId: string) => (sessionId === "chat-chief" ? { name: "Chief of Staff", ref: "chief-of-staff" } : undefined);
const turn = { sessionId: "chat-mate", providerTurnId: "t3x_cnVuOjI", text: "Example: count the lines of README.md\nand report the number." };

describe("a turn the engine began, as its chat shows it", () => {
  it("is a quiet note from the chat that sent it, with a request that follows the engine's run", () => {
    const made = engineTurnFor({ ...turn, fromSessionId: "chat-chief" }, { blocks: [] }, sender);
    expect(made).toEqual({
      text: turn.text,
      monoNote: { kind: "message", from: "Chief of Staff", ref: "chief-of-staff", line: "Example: count the lines of README.md" },
      appRequestId: "engine-turn-t3x_cnVuOjI",
    });
    expect(engineTurnOf(made?.appRequestId)).toBe(turn.providerTurnId);
  });

  it("is a brief when the chat that sent it leads this one: a Brief line, the work in the open", () => {
    const leads = (sessionId: string) => ({ ...sender(sessionId)!, leads: true });
    const made = engineTurnFor({ ...turn, fromSessionId: "chat-chief" }, { blocks: [] }, leads);
    expect(made).toEqual({ text: `[MonoCode brief from Chief of Staff]\n${turn.text}`, appRequestId: "engine-turn-t3x_cnVuOjI" });
    expect(briefView(made?.text)).toMatchObject({ from: "Chief of Staff", job: "Example: count the lines of README.md" });
  });

  it("says what began it when no chat here sent it", () => {
    const from = (extra: Record<string, unknown>) => engineTurnFor({ ...turn, ...extra }, { blocks: [] }, sender)?.monoNote?.from;
    expect(from({ scheduled: true })).toBe("Scheduled task");
    expect(from({ fromSessionId: "chat-unknown" })).toBe("Another window");
    expect(from({})).toBe("Another window");
    const woken = engineTurnFor({ ...turn, text: "" }, { blocks: [] }, sender);
    expect(woken?.monoNote?.from).toBe("Background work");
    expect(woken?.text).toBe("Background work finished, so the chat carried on by itself.");
  });

  it("is nothing when the chat already shows that run or has its note waiting", () => {
    const own: Block = { id: "b1", role: "user", text: "Example: typed here", providerTurnId: turn.providerTurnId };
    const noted: Block = { id: "b2", role: "user", text: turn.text, appRequestId: "engine-turn-t3x_cnVuOjI" };
    expect(engineTurnFor(turn, { blocks: [own] }, sender)).toBeNull();
    expect(engineTurnFor(turn, { blocks: [noted] }, sender)).toBeNull();
    expect(engineTurnFor(turn, { blocks: [], queuedMessages: [{ id: "q1", text: turn.text, appRequestId: "engine-turn-t3x_cnVuOjI" }] }, sender)).toBeNull();
    // An answer that happens to carry the id is not the chat's own turn of it.
    expect(engineTurnFor(turn, { blocks: [{ id: "b3", role: "assistant", text: "Example", providerTurnId: turn.providerTurnId }] }, sender)).not.toBeNull();
  });
});
