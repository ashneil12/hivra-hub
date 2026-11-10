import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";

const store = new Map<string, Session>();
vi.mock("../../sessions/data/sessionStore", () => ({
  getSession: vi.fn(async (id: string) => store.get(id) ?? null),
  upsertSession: vi.fn(async (session: Session) => {
    store.set(session.id, session);
    return null;
  }),
}));

import { upsertSession } from "../../sessions/data/sessionStore";
import { sessionStoreChatPort } from "./teleportStorePort";
import { teleportStateOf } from "../model/teleportState";

const session = (): Session =>
  ({
    id: "c9",
    harness: "claude",
    model: "test-model-1",
    modelSettings: { effort: "high" },
    runtimeMode: "default",
    title: "Stored chat",
    cwd: "/projects/x",
    blocks: [{ id: "b1", role: "user", text: "hello" }],
  }) as unknown as Session;

describe("WP-177 desktop chat store binding", () => {
  beforeEach(() => {
    store.clear();
    vi.mocked(upsertSession).mockClear();
  });

  it("reads and writes a chat through the desktop store", async () => {
    const port = sessionStoreChatPort();
    store.set("c9", session());
    expect((await port.get("c9"))?.title).toBe("Stored chat");
    await port.put({ ...session(), title: "Back" });
    expect(store.get("c9")?.title).toBe("Back");
  });

  it("marks a chat moved by saving it with only the marker, so the transcript leaves this Mac", async () => {
    const port = sessionStoreChatPort();
    store.set("c9", session());
    await port.markMoved("c9", "Studio box", "2026-11-10T09:00:00.000Z");
    const saved = store.get("c9")!;
    expect(saved.blocks.some((b) => b.role === "user")).toBe(false);
    expect(teleportStateOf(saved)).toEqual({ moved: true, host: "Studio box", at: "2026-11-10T09:00:00.000Z" });
    expect(saved.title).toBe("Stored chat");
  });

  it("does nothing when there is no chat to mark", async () => {
    const port = sessionStoreChatPort();
    await port.markMoved("missing", "Studio box", "2026-11-10T09:00:00.000Z");
    expect(upsertSession).not.toHaveBeenCalled();
  });
});
