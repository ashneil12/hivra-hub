import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { chatLocked, teleportStateOf, movedBlocks, returnedBlocks, sendBlockReason, copyForMoved } from "./teleportState";

const base = (blocks: Block[] = []): Session =>
  ({ id: "c1", harness: "claude", model: "m", modelSettings: {}, runtimeMode: "default", title: "T", cwd: "/p", blocks } as unknown as Session);

const notice = (id: string, kind: string, text: string): Block => ({ id, role: "system", text, notice: kind } as unknown as Block);

describe("WP-177 moved state", () => {
  it("a chat with no teleport notice is not moved", () => {
    expect(teleportStateOf(base([{ id: "u", role: "user", text: "hi" } as Block]))).toEqual({ moved: false });
  });

  it("the moved notice is durable in the chat itself, with the host and the time", () => {
    const blocks = movedBlocks("Studio box", "2026-11-10T09:00:00.000Z");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].notice).toBe("teleported");
    expect(teleportStateOf(base(blocks))).toEqual({ moved: true, host: "Studio box", at: "2026-11-10T09:00:00.000Z" });
  });

  it("moving back clears the moved state, and the latest notice wins", () => {
    const away = movedBlocks("Studio box", "2026-11-10T09:00:00.000Z");
    const back = [...away, ...returnedBlocks("2026-11-10T10:00:00.000Z")];
    expect(teleportStateOf(base(back))).toEqual({ moved: false });
  });

  it("refuses sends and locks a moved chat with the reason", () => {
    expect(sendBlockReason(base(movedBlocks("Studio box", "2026-11-10T09:00:00.000Z")))).toMatch(/moved to Studio box/);
    expect(sendBlockReason(base())).toBeNull();
  });

  it("the lock follows the same state, so the harness can refuse by id", () => {
    expect(chatLocked(base(movedBlocks("H", "2026-11-10T09:00:00.000Z")))).toBe(true);
    expect(chatLocked(base())).toBe(false);
  });

  it("says plainly that the target starts a fresh CLI session from the saved messages", () => {
    const copy = copyForMoved("Studio box", "10 Nov 2026, 09:00");
    expect(copy).toContain("fresh session");
    expect(copy).toContain("saved messages");
    expect(copy).not.toMatch(/[–—]/);
  });
});
