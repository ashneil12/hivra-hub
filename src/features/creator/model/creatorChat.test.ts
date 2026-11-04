// @vitest-environment happy-dom
// WP-34. Build starts a chat with the Creator Mono. The brief carries the ask, the kind, the id and the revision.
// draftFor is not on this path.
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { newSession, type Session } from "../../sessions/model/session";
import { isWaitingBrief } from "../../sessions/model/messageQueue";
import { findMono, listMonos, removeMono } from "../../monos/model/mono";
import { ensureMonoSession } from "../../monos/model/monoWorkspace";
import { beginCreatorBuild, CREATOR_MONO_ID } from "./creatorChat";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  for (const mono of listMonos()) removeMono(mono.id);
});

it("starts the Creator Mono's chat and puts the ask in its brief", async () => {
  const stored = new Map<string, Session>();
  invokeMock.mockResolvedValueOnce({
    id: "11111111-1111-4111-8111-111111111111",
    view: "this-view",
    revision: 1,
    phase: "started",
    plugin: null,
    expect: "panel",
    enabledGlobally: false,
    visibleHere: false,
    mcpApproved: false,
    mcpWaiting: false,
    scriptWaiting: false,
    reports: [],
    panel: null,
    skills: [],
    mcpServers: [],
    mcpTools: [],
    mcpNote: null,
  });
  const host = {
    home: async () => "/home",
    load: async (id: string) => stored.get(id),
    create: (cwd: string) => newSession("claude", cwd),
    add: (session: Session) => {
      stored.set(session.id, session);
    },
    update: (session: Session) => {
      stored.set(session.id, session);
    },
  };
  const started = await beginCreatorBuild({ kind: "panel", ask: "Ship the panel", host });
  expect(invokeMock).toHaveBeenCalledTimes(1);
  expect(invokeMock).toHaveBeenCalledWith("creator_start", { view: "main", expect: "panel" });
  expect(started.brief).toContain("Ship the panel");
  expect(started.brief).toContain("panel");
  expect(started.brief).toContain(started.state.id);
  expect(started.brief).toContain(String(started.state.revision));
  expect(findMono(CREATOR_MONO_ID)?.name).toBe("Creator");
  const session = stored.get(started.sessionId);
  expect(session).toBeTruthy();
  expect(isWaitingBrief(session?.queuedMessages?.[0])).toBe(true);
  expect(session?.queuedMessages?.[0]?.text).toBe(started.brief);
  const again = await ensureMonoSession(CREATOR_MONO_ID, host);
  expect(again?.id).toBe(started.sessionId);
});
