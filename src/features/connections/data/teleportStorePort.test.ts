import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";

const store = new Map<string, Session>();
vi.mock("../../sessions/data/sessionStore", () => ({
  getSession: vi.fn(async (id: string) => store.get(id) ?? null),
  // The move reads the full row, not the truncated sidebar read (WP-177).
  readSessionForMove: vi.fn(async (id: string) => store.get(id) ?? null),
  upsertSession: vi.fn(async (session: Session) => {
    store.set(session.id, session);
    return null;
  }),
}));

import { upsertSession } from "../../sessions/data/sessionStore";
import { sessionStoreChatPort } from "./teleportStorePort";

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

});
