// @vitest-environment happy-dom
// G15 (Dropwave wiring): New page and Change on the Pages screen go to the chosen first mate's own chat as a page build
// ask, and that chat's page_build comes back to the card. A first mate that is busy, has no chat, or never answers with
// a page ends in a clear line with Try again, within the bound. The dev stub still answers the browser preview.
import { afterAll, beforeEach, expect, it } from "vitest";
import type { HomeChiefHost, HomeChiefSession } from "../../home/model/homeChief";
import { hubData, setHubDataSource } from "../../hub/model/hubData";
import { chatPreview, previewFromChat, settleChatPreview } from "../../selfBuild/model/pagesChat";
import { chatPageVersion, resetPageAsksForTest } from "../../selfBuild/model/pageAsks";
import { BUILD_TOTAL_SECONDS, buildPage, rebuildPage } from "./buildPage";
import { resetPagesForTest } from "./pages";
import type { PageSpec } from "./pageSpec";

const roster = [{ id: "ed", name: "Ed" }, { id: "bo", name: "Bo" }];
const SPEC = { kind: "blocks", title: "Agents now", blocks: [{ kind: "note", title: "About", text: "What each agent does." }] };
const CURRENT: PageSpec = { kind: "blocks", title: "Agents", blocks: [{ kind: "note", title: "Now", text: "Three agents running." }] };
const CHANGED = { kind: "blocks", title: "Agents and stuck time", blocks: [{ kind: "note", title: "Now", text: "Three agents running, one stuck for 2h." }] };

beforeEach(() => {
  localStorage.clear();
  resetPagesForTest();
  resetPageAsksForTest();
  setHubDataSource(undefined);
  const src = Object.create(hubData());
  src.listProjects = () => [{ id: "hivra", name: "Hivra", folder: "/w/hivra" }];
  setHubDataSource(src);
});
afterAll(() => setHubDataSource(undefined));

/** A first mate's chat as the app lends it: the session, what was sent to it, and what it does on each look. */
function fakeChat(opts: { session?: boolean; busy?: boolean; question?: boolean; onRead?: (reads: number, chat: FakeChat) => void } = {}) {
  const chat = {
    ensured: [] as string[],
    sent: [] as { sessionId: string; text: string }[],
    busy: !!opts.busy,
    blocks: [] as HomeChiefSession["blocks"][number][],
    reads: 0,
    host: undefined as unknown as HomeChiefHost,
  };
  chat.host = {
    ensure: async (monoId) => {
      chat.ensured.push(monoId);
      return opts.session === false ? undefined : { id: `chat-${monoId}` };
    },
    submit: (sessionId, text) => {
      chat.sent.push({ sessionId, text });
      chat.blocks.push({ role: "user", text });
      chat.busy = true;
      return true;
    },
    answer: () => undefined,
    read: (id) => {
      chat.reads += 1;
      opts.onRead?.(chat.reads, chat);
      return {
        id,
        busy: chat.busy,
        blocks: chat.blocks,
        ...(opts.question ? { pendingQuestion: { requestId: 1, questions: [{ id: "q", prompt: "Which one?", options: [] }] } } : {}),
      };
    },
  };
  return chat;
}
type FakeChat = ReturnType<typeof fakeChat>;

/** A clock that only moves when the build waits. */
function clock() {
  const start = Date.now();
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, elapsed: () => t - start };
}

it("New page sends the description to the chosen first mate's own chat, and its page_build preview fills the card", async () => {
  const time = clock();
  const chat = fakeChat({
    onRead: (reads, c) => {
      // Ed reads the project's data for a few looks, then answers with page_build in that chat.
      if (reads === 3) previewFromChat({ project: "hivra", spec: SPEC, request: "a page of every agent" }, { monoId: "ed", name: "Ed" });
      if (reads === 4) c.busy = false;
    },
  });
  const result = await buildPage({ projectId: "hivra", monoId: "ed", prompt: "a page of every agent" }, { roster, chat: chat.host, ...time });

  expect(chat.ensured).toEqual(["ed"]);
  expect(chat.sent).toHaveLength(1);
  expect(chat.sent[0].sessionId).toBe("chat-ed");
  expect(chat.sent[0].text).toContain("“a page of every agent”");
  expect(chat.sent[0].text).toContain("page_build");
  expect(chat.sent[0].text).toContain('project "Hivra"');
  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.spec.title).toBe("Agents now");
  // The card shows the same preview the chat made, so Keep or Discard there settles it everywhere.
  expect(result.previewId).toBeTruthy();
  expect(chatPreview(result.previewId!)?.page.monoId).toBe("ed");
  expect(time.elapsed()).toBeLessThan(BUILD_TOTAL_SECONDS * 1000);
  settleChatPreview(result.previewId!);
});

it("the page_build answer tells the first mate the preview is on the Pages card; a page asked in chat keeps its old note", async () => {
  let out: ReturnType<typeof previewFromChat> | undefined;
  const chat = fakeChat({ onRead: (reads) => { if (reads === 2) out = previewFromChat({ project: "hivra", spec: SPEC }, { monoId: "ed", name: "Ed" }); } });
  await buildPage({ projectId: "hivra", monoId: "ed", prompt: "a page of every agent" }, { roster, chat: chat.host, ...clock() });
  expect(out!.note).toMatch(/Hubs card/);
  expect(out!.project).toBe("Hivra");
  settleChatPreview(out!.previewId);
  // No ask open any more: the chat's own build is shown as before.
  const plain = previewFromChat({ spec: SPEC }, { monoId: "ed", name: "Ed" });
  expect(plain.note).toMatch(/bottom of the window/);
  settleChatPreview(plain.previewId);
});

it("Change on a kept page sends the page as it is now with the ask, and the answer is a new version of that page", async () => {
  const time = clock();
  let answer: Record<string, unknown> | undefined;
  const chat = fakeChat({
    onRead: (reads, c) => {
      if (reads === 2) answer = previewFromChat({ project: "hivra", spec: CHANGED, request: "Add stuck time" }, { monoId: "bo", name: "Bo" });
      if (reads === 3) c.busy = false;
    },
  });
  const result = await rebuildPage(
    { pageId: "page-agents", monoId: "bo", prompt: "Add stuck time", current: CURRENT, projectId: "hivra" },
    { roster, chat: chat.host, ...time },
  );

  expect(chat.ensured).toEqual(["bo"]);
  const text = chat.sent[0].text;
  expect(text).toContain("“Agents”");
  expect(text).toContain("“Add stuck time”");
  expect(text).toContain(JSON.stringify(CURRENT, null, 2));
  expect(text).toMatch(/don't call keep/);
  expect(result).toMatchObject({ status: "ready", spec: { title: "Agents and stuck time" }, replaces: "page-agents" });
  // Not a new page: nothing waits as a new-page preview, and the version waits on the kept page.
  expect(result.status === "ready" && result.previewId).toBeFalsy();
  expect(answer?.previewId).toBeUndefined();
  expect(String(answer?.where)).toContain("new version of “Agents”");
  expect(chatPageVersion("page-agents")?.spec.title).toBe("Agents and stuck time");
});

it("a first mate that never answers with a page ends in a Try again line within the bound", async () => {
  const time = clock();
  const chat = fakeChat(); // busy with the ask for ever, and no page_build
  const result = await buildPage({ projectId: "hivra", monoId: "ed", prompt: "a page of every agent" }, { roster, chat: chat.host, ...time });
  expect(result.status).toBe("no-page");
  expect(result.status !== "ready" && result.reason).toMatch(/Try again/);
  expect(time.elapsed()).toBeLessThanOrEqual(BUILD_TOTAL_SECONDS * 1000);
  expect(chat.sent).toHaveLength(1);
});

it("a change that comes after the card stopped waiting still lands on its kept page", async () => {
  const chat = fakeChat();
  const result = await rebuildPage({ pageId: "page-agents", monoId: "ed", prompt: "Add stuck time", current: CURRENT }, { roster, chat: chat.host, ...clock() });
  expect(result.status).toBe("no-page");
  expect(result.status !== "ready" && result.reason).toContain("the new version waits on this hub");
  previewFromChat({ spec: CHANGED, request: "Add stuck time" }, { monoId: "ed", name: "Ed" });
  expect(chatPageVersion("page-agents")?.spec.title).toBe("Agents and stuck time");
});

it("a first mate whose turn ends without a page says so at once, with its reply, not after the whole wait", async () => {
  const time = clock();
  const chat = fakeChat({
    onRead: (reads, c) => {
      if (reads === 2) {
        c.blocks.push({ role: "assistant", text: "I can't see that project's board from here." });
        c.busy = false;
      }
    },
  });
  const result = await buildPage({ projectId: "hivra", monoId: "ed", prompt: "a page of every agent" }, { roster, chat: chat.host, ...time });
  expect(result.status).toBe("no-page");
  expect(result.status !== "ready" && result.reason).toContain("I can't see that project's board from here.");
  expect(result.status !== "ready" && result.reason).toMatch(/Try again/);
  expect(time.elapsed()).toBeLessThan(10_000);
});

it("a busy first mate, or one waiting on your answer, gets nothing sent and a Try again line", async () => {
  for (const chat of [fakeChat({ busy: true }), fakeChat({ question: true })]) {
    const result = await buildPage({ projectId: "hivra", monoId: "ed", prompt: "a page" }, { roster, chat: chat.host, ...clock() });
    expect(result.status).toBe("busy");
    expect(result.status !== "ready" && result.reason).toMatch(/^Ed /);
    expect(chat.sent).toEqual([]);
  }
});

it("a first mate with no chat to take it, or no chat reachable from here, says so plainly", async () => {
  const none = fakeChat({ session: false });
  const noChat = await buildPage({ projectId: "hivra", monoId: "ed", prompt: "a page" }, { roster, chat: none.host, ...clock() });
  expect(noChat.status).toBe("error");
  expect(noChat.status !== "ready" && noChat.reason).toMatch(/Try again/);
  expect(none.sent).toEqual([]);
  const unreachable = await buildPage({ projectId: "hivra", monoId: "ed", prompt: "a page" }, { roster, chat: null, ...clock() });
  expect(unreachable.status).toBe("error");
});

it("the dev stub still answers the browser preview without a chat", async () => {
  const chat = fakeChat();
  const built = await buildPage({ projectId: "hivra", monoId: "ed", prompt: "EXO bugs" }, { roster, stub: true, chat: chat.host });
  expect(built.status).toBe("ready");
  const changed = await rebuildPage({ pageId: "p-1", monoId: "ed", prompt: "add a row", current: CURRENT }, { roster, stub: true, chat: chat.host });
  expect(changed.status).toBe("ready");
  expect(chat.ensured).toEqual([]);
});
