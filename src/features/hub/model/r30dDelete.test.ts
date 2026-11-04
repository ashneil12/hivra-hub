// @vitest-environment happy-dom
// r30d: deleting a room takes the room and its threads only (never the Leadership team, a Mono, a soul or other rooms),
// and deleting a team's sub-chat closes its tab rather than leaving an empty "New session" behind.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import { removeSessionFromWorkspace } from "../../sessions/model/sessionWorkspaceLifecycle";
import { newTab, type WorkspaceTab } from "../../workspace/model/layout";
import type { ChildChat } from "../../monos/model/delegationView";
import { resetSubChatFolds, subChatAttention, useSubChatFolds } from "../../monos/model/subChats";
import { SubChatList } from "../../monos/ui/SubChatList";
import { ConfirmDeleteHost, resetConfirmDelete } from "../../../shared/ui/ConfirmDelete";
import { deleteRoom } from "../ui/HubProjectItems";
import { deleteChat, getChat, loadRooms, resetRoomsForTests, roomWritesSettled } from "./hubChats";
import type { RoomBackend } from "./roomStore";
import type { GroupChat } from "./types";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  resetConfirmDelete();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  resetRoomsForTests();
});

const room = (id: string, isDefault = false): GroupChat => ({
  id, projectId: "hivra", name: isDefault ? "Leadership team" : `Example: ${id}`, isDefault, memberIds: ["ed"],
  conversations: [{ id: "c1", when: "Today", title: "Example: plan", messages: [{ id: "m1", from: "ash", text: "Example: hi" }] }],
});
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);

describe("deleting a room", () => {
  it("takes that room only, through the store's own delete, and never the Leadership team", async () => {
    const deleted: string[] = [];
    const stored = (id: string, isDefault = false) => ({ id, projectId: "hivra", name: isDefault ? "Leadership team" : `Example: ${id}`,
      isDefault, memberIds: ["ed"], seated: false, createdAt: 1, updatedAt: 1, conversations: [] });
    const backend = {
      kind: "app",
      load: async () => ({ rooms: [stored("hivra:leadership", true), stored("hivra:chat-a"), stored("hivra:chat-b")] }),
      deleteRoom: async (id: string) => void deleted.push(id),
      upsertRoom: async () => undefined,
      import: async () => ({ rooms: 0, conversations: 0, messages: 0 }),
    } as unknown as RoomBackend;
    await loadRooms(backend);
    expect(deleteChat("hivra:leadership")).toBe(false);
    expect(getChat("hivra:leadership")).toBeDefined();
    expect(deleteChat("hivra:chat-a")).toBe(true);
    await roomWritesSettled();
    expect(deleted).toEqual(["hivra:chat-a"]);
    expect(getChat("hivra:chat-a")).toBeUndefined();
    expect(getChat("hivra:chat-b")).toBeDefined();
  });

  it("asks first: Cancel keeps the room, Delete takes it", async () => {
    resetRoomsForTests([room("hivra:leadership", true), room("hivra:chat-a")]);
    act(() => root.render(createElement(ConfirmDeleteHost)));
    const item = { id: "chat:hivra:chat-a", kind: "group-chat" as const, title: "Example: hivra:chat-a" };
    let done: Promise<boolean> | undefined;
    await act(async () => void (done = deleteRoom("hivra", item, { project: "hivra", item: item.id } as never)));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Delete “Example: hivra:chat-a”?");
    await act(async () => button("Cancel")!.click());
    expect(await done).toBe(false);
    expect(getChat("hivra:chat-a")).toBeDefined();
    await act(async () => void (done = deleteRoom("hivra", item, { project: "hivra", item: item.id } as never)));
    await act(async () => button("Delete")!.click());
    expect(await done).toBe(true);
    expect(getChat("hivra:chat-a")).toBeUndefined();
    expect(getChat("hivra:leadership")).toBeDefined();
  });
});

describe("deleting a team's sub-chat", () => {
  const session = (id: string, cwd = "/work/hivra"): Session => ({ ...newSession("cursor", cwd), id });
  const tab = (id: string, sessionId: string): WorkspaceTab => ({ ...newTab(sessionId), id });

  it("closes its tab instead of leaving an empty New session, when another tab is left", () => {
    const input = {
      tabs: [tab("t-ex", "ex-other"), tab("t-sub", "ex-sub")],
      sessions: [session("ex-other", "/work/exo"), session("ex-sub")],
      sessionId: "ex-sub",
      activeTabId: "t-sub",
      scope: "project" as const,
      createReplacement: (seed: Session | undefined) => session("replacement", seed?.cwd),
    };
    // A plain session keeps its project's place with a fresh one (unchanged).
    expect(removeSessionFromWorkspace(input).sessions.map((s) => s.id)).toContain("replacement");
    const sub = removeSessionFromWorkspace({ ...input, replaceEmptyTab: false });
    expect(sub.sessions.map((s) => s.id)).toEqual(["ex-other"]);
    expect(sub.tabs.map((t) => t.id)).toEqual(["t-ex"]);
    expect(sub.activeTabId).toBe("t-ex");
  });

  it("offers Delete on its row in the team's list", () => {
    const NOW = 1_700_000_000_000;
    const children: ChildChat[] = [{ sessionId: "ex-sub", ownerSession: "lead", title: "Example: run the tests", state: "completed", createdAt: NOW - 60_000 }];
    const onDelete = vi.fn();
    resetSubChatFolds();
    function List() {
      useSubChatFolds();
      return createElement(SubChatList, { foldKey: "chat:lead", owner: "lead", children, attention: subChatAttention(children, NOW), now: NOW, onOpen: vi.fn(), onDelete });
    }
    act(() => root.render(createElement(List)));
    const toggle = container.querySelector<HTMLButtonElement>("[data-sub-chats-toggle]")!;
    if (toggle.getAttribute("aria-expanded") !== "true") act(() => toggle.click());
    const del = container.querySelector<HTMLButtonElement>('[data-sub-chat-delete="ex-sub"]')!;
    expect(del.getAttribute("aria-label")).toBe("Delete Example: run the tests");
    act(() => del.click());
    expect(onDelete).toHaveBeenCalledWith(children[0]);
  });
});
