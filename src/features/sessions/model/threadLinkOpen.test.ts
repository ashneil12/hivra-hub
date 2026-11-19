import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearComposerDraft, getComposerDraft, setComposerDraft } from "./draftCache";
import { newSession } from "./session";
import {
  acceptThreadLink,
  beginThreadOpen,
  placePrompt,
  readComposerPrefill,
  rememberPromptSession,
  reportThreadLink,
  requestComposerPrefill,
  resetThreadLinkStateForTests,
  THREAD_LINK_LOOKUP_MS,
  threadLinkNotice,
  type ThreadLinkHands,
  type ThreadPromptHands,
  type ThreadPromptSession,
  type ThreadPromptWorld,
} from "./threadLinkOpen";
import { THREAD_LINK_MESSAGE, chatLink, promptLink } from "./threadLinks";

const CHAT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FOLDER = "/work/demo";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function hands(
  lookup: Partial<ThreadLinkHands> & Pick<ThreadLinkHands, "hasChat">,
): ThreadLinkHands & { opened: string[] } {
  const opened: string[] = [];
  return {
    hasProject: () => false,
    openChat: (id) => {
      opened.push(id);
      return true;
    },
    openPrompt: (id) => opened.push(`prompt:${id}`),
    opened,
    ...lookup,
  };
}

function world(
  projects: ThreadPromptWorld["projects"],
  sessions: ThreadPromptSession[] = [],
): ThreadPromptWorld & { list: ThreadPromptSession[] } {
  const list = sessions;
  return {
    list,
    projects,
    sessions: () => list,
  };
}

function promptHands(): ThreadPromptHands & {
  opened: string[];
  added: { id: string; cwd: string; composerSeed?: string }[];
  focused: string[];
} {
  const opened: string[] = [];
  const added: { id: string; cwd: string; composerSeed?: string }[] = [];
  const focused: string[] = [];
  return {
    opened,
    added,
    focused,
    openProject: (id) => opened.push(id),
    addSession: (session) => added.push(session),
    focusSession: (id) => focused.push(id),
  };
}

beforeEach(() => {
  resetThreadLinkStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetThreadLinkStateForTests();
});

describe("resolve and open", () => {
  it("keeps every message free of a dash and a web address", () => {
    for (const message of Object.values(THREAD_LINK_MESSAGE)) {
      expect(message).not.toMatch(/[—–]/);
      expect(message.toLowerCase()).not.toContain("http");
    }
  });

  it("a late lookup does not open over a newer link", async () => {
    const firstCheck = deferred<boolean>();
    const first = hands({ hasChat: () => firstCheck.promise });
    const pending = acceptThreadLink(chatLink(CHAT)!, first);
    const second = hands({ hasChat: () => true });
    await acceptThreadLink(chatLink(OTHER)!, second);
    firstCheck.resolve(true);
    await pending;
    expect(first.opened).toEqual([]);
    expect(second.opened).toEqual([OTHER]);
    expect(threadLinkNotice()).toBeNull();
  });

  it("an invalid id error is not on this computer, not a retry", async () => {
    const asError = hands({
      hasChat: () => Promise.reject(new Error("Invalid session id")),
    });
    await acceptThreadLink(chatLink(CHAT)!, asError);
    expect(asError.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.missingChat);

    resetThreadLinkStateForTests();
    const asString = hands({
      hasChat: () => Promise.reject("Invalid session id"),
    });
    await acceptThreadLink(chatLink(CHAT)!, asString);
    expect(asString.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.missingChat);

    resetThreadLinkStateForTests();
    const project = hands({
      hasChat: () => false,
      hasProject: () => Promise.reject(new Error("Invalid project id")),
    });
    await acceptThreadLink(promptLink("exo", "hello")!, project);
    expect(project.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.missingProject);
  });

  it("a thrown lookup is a retry, not a missing chat", async () => {
    const opened = hands({
      hasChat: () => {
        throw new Error("disk");
      },
    });
    await acceptThreadLink(chatLink(CHAT)!, opened);
    expect(opened.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.unavailable);
    expect(threadLinkNotice()?.message).not.toBe(THREAD_LINK_MESSAGE.missingChat);
  });

  it("a rejected lookup is a retry, not a missing chat", async () => {
    const opened = hands({ hasChat: () => Promise.reject(new Error("timeout")) });
    await acceptThreadLink(chatLink(CHAT)!, opened);
    expect(opened.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.unavailable);
  });

  it("a lookup that never answers is a retry, not a missing chat", async () => {
    vi.useFakeTimers();
    const opened = hands({ hasChat: () => new Promise(() => {}) });
    let release: (value: boolean) => void = () => {};
    opened.hasChat = () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      });
    const pending = acceptThreadLink(chatLink(CHAT)!, opened);
    await vi.advanceTimersByTimeAsync(THREAD_LINK_LOOKUP_MS);
    await pending;
    release(true);
    await Promise.resolve();
    expect(opened.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.unavailable);
  });

  it("a chat that disappears before the second check is missing", async () => {
    let seen = 0;
    const opened = hands({
      hasChat: () => {
        seen += 1;
        return seen === 1;
      },
    });
    await acceptThreadLink(chatLink(CHAT)!, opened);
    expect(opened.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.missingChat);
    expect(JSON.stringify(threadLinkNotice())).not.toContain("http");
    expect(JSON.stringify(threadLinkNotice())).not.toContain(CHAT);
  });

  it("a chat that disappears after the checks is missing", async () => {
    let seen = 0;
    const opened = hands({
      hasChat: () => {
        seen += 1;
        return seen < 3;
      },
    });
    await acceptThreadLink(chatLink(CHAT)!, opened);
    expect(opened.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.missingChat);
  });

  it("a chat that is not shown is not on this computer", async () => {
    const opened = hands({
      hasChat: () => true,
      openChat: async () => false,
    });
    await acceptThreadLink(chatLink(CHAT)!, opened);
    expect(opened.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.missingChat);
  });

  it("a stale open does not warn when the pane was not shown", async () => {
    let started = false;
    let release: (shown: boolean) => void = () => {};
    const first = hands({
      hasChat: () => true,
      openChat: () => {
        started = true;
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
    });
    const pending = acceptThreadLink(chatLink(CHAT)!, first);
    for (let i = 0; i < 30 && !started; i += 1) await Promise.resolve();
    expect(started).toBe(true);
    const second = hands({ hasChat: () => true, openChat: async () => true });
    await acceptThreadLink(chatLink(OTHER)!, second);
    release(false);
    await pending;
    expect(threadLinkNotice()).toBeNull();
  });

  it("a chat that appears on the later check opens", async () => {
    let seen = 0;
    const opened = hands({
      hasChat: () => {
        seen += 1;
        return seen >= 2;
      },
    });
    await acceptThreadLink(chatLink(CHAT)!, opened);
    expect(opened.opened).toEqual([CHAT]);
    expect(threadLinkNotice()).toBeNull();
  });

  it("an off-machine link is refused and the address is not shown", async () => {
    const opened = hands({ hasChat: () => true });
    await acceptThreadLink("https://evil.example/guest?sig=1", opened);
    expect(opened.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.offMachine);
    expect(JSON.stringify(threadLinkNotice())).not.toContain("evil.example");
  });

  it("a public link is refused", async () => {
    const opened = hands({ hasChat: () => true, hasProject: () => true });
    await acceptThreadLink("hivra://local/guest/hello", opened);
    expect(opened.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.public);
  });

  it("a missing project is a message and does not open a chat", async () => {
    const opened = hands({ hasChat: () => false, hasProject: () => false });
    await acceptThreadLink(promptLink("exo", "hello")!, opened);
    expect(opened.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.missingProject);
  });
});

describe("placePrompt", () => {
  it("does not replace an unsent draft in a blank chat", () => {
    const mine = beginThreadOpen();
    const blank = { ...newSession("claude", FOLDER), blocks: [], busy: false };
    setComposerDraft(blank.id, "half typed");
    const here = world(() => [{ id: "exo", folder: FOLDER }], [blank]);
    const used = promptHands();
    placePrompt("exo", "Ship the notes", mine, here, used);
    expect(getComposerDraft(blank.id)).toBe("half typed");
    expect(used.added).toHaveLength(1);
    expect(used.added[0]?.id).not.toBe(blank.id);
    expect(getComposerDraft(used.added[0]!.id)).toBe("Ship the notes");
    expect(used.focused).toEqual([used.added[0]!.id]);
    clearComposerDraft(blank.id);
    clearComposerDraft(used.added[0]!.id);
  });

  it("fills a blank chat in the project and does not add another", () => {
    const mine = beginThreadOpen();
    const blank = { ...newSession("claude", `${FOLDER}/`), blocks: [], busy: false };
    const here = world(() => [{ id: "exo", folder: FOLDER }], [blank]);
    const used = promptHands();
    placePrompt("exo", "Ship the notes", mine, here, used);
    expect(used.opened).toEqual(["exo"]);
    expect(used.added).toEqual([]);
    expect(used.focused).toEqual([blank.id]);
    expect(getComposerDraft(blank.id)).toBe("Ship the notes");
  });

  it("adds a chat when the only one is busy or already has messages", () => {
    const mine = beginThreadOpen();
    const busy = { ...newSession("claude", FOLDER), blocks: [], busy: true };
    const filled = {
      ...newSession("claude", FOLDER),
      blocks: [{ role: "user" }],
    };
    const here = world(() => [{ id: "exo", folder: FOLDER }], [busy, filled]);
    const used = promptHands();
    placePrompt("exo", "Again", mine, here, used);
    expect(used.added).toHaveLength(1);
    expect(used.added[0]?.composerSeed).toBe("Again");
    expect(used.added[0]?.cwd).toBe(FOLDER);
    expect(used.focused).toEqual([used.added[0]!.id]);
    expect(getComposerDraft(used.added[0]!.id)).toBe("Again");
    expect(used.focused).not.toContain(busy.id);
  });

  it("matches a windows folder to the blank chat", () => {
    const mine = beginThreadOpen();
    const blank = { ...newSession("claude", "C:/work/demo"), blocks: [] };
    const here = world(() => [{ id: "exo", folder: "C:\\work\\demo" }], [blank]);
    const used = promptHands();
    placePrompt("exo", "Hi", mine, here, used);
    expect(used.added).toEqual([]);
    expect(used.focused).toEqual([blank.id]);
  });

  it("a stale ticket writes nothing", () => {
    const mine = beginThreadOpen();
    beginThreadOpen();
    const here = world(() => [{ id: "exo", folder: FOLDER }]);
    const used = promptHands();
    placePrompt("exo", "Late", mine, here, used);
    expect(used.opened).toEqual([]);
    expect(used.added).toEqual([]);
    expect(used.focused).toEqual([]);
    expect(threadLinkNotice()).toBeNull();
  });

  it("stops after the project opens when a newer link has started", () => {
    const mine = beginThreadOpen();
    const here = world(() => [{ id: "exo", folder: FOLDER }]);
    const used = promptHands();
    used.openProject = () => {
      used.opened.push("exo");
      beginThreadOpen();
    };
    placePrompt("exo", "Late", mine, here, used);
    expect(used.opened).toEqual(["exo"]);
    expect(used.added).toEqual([]);
    expect(threadLinkNotice()).toBeNull();
  });

  it("a missing project does not open or add a chat", () => {
    const mine = beginThreadOpen();
    const here = world(() => []);
    const used = promptHands();
    placePrompt("gone", "Hi", mine, here, used);
    expect(used.opened).toEqual([]);
    expect(used.added).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.missingProject);
  });

  it("a project with no folder does not open or add a chat", () => {
    const mine = beginThreadOpen();
    const here = world(() => [{ id: "exo", folder: null }]);
    const used = promptHands();
    placePrompt("exo", "Hi", mine, here, used);
    expect(used.opened).toEqual([]);
    expect(used.added).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.noFolder);
  });

  it("an empty folder does not open or add a chat", () => {
    const mine = beginThreadOpen();
    const here = world(() => [{ id: "exo", folder: "" }]);
    const used = promptHands();
    placePrompt("exo", "Hi", mine, here, used);
    expect(used.opened).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.noFolder);
  });

  it("a project that vanishes after the open is missing", () => {
    const mine = beginThreadOpen();
    let projects = [{ id: "exo", folder: FOLDER }];
    const here = world(() => projects);
    const used = promptHands();
    used.openProject = () => {
      used.opened.push("exo");
      projects = [];
    };
    placePrompt("exo", "Hi", mine, here, used);
    expect(used.added).toEqual([]);
    expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.missingProject);
  });
});

describe("prefill and remember", () => {
  it("a stale prefill does not change the draft", () => {
    const mine = beginThreadOpen();
    beginThreadOpen();
    expect(requestComposerPrefill(CHAT, "nope", mine)).toBe(false);
    expect(getComposerDraft(CHAT)).toBeUndefined();
    expect(readComposerPrefill({ sessionId: CHAT, text: "nope", ticket: mine }, CHAT)).toBeNull();
  });

  it("a current prefill is kept for that chat only", () => {
    const mine = beginThreadOpen();
    expect(readComposerPrefill({ sessionId: CHAT, text: "Yes", ticket: mine }, CHAT)).toBe("Yes");
    expect(readComposerPrefill({ sessionId: CHAT, text: "Yes", ticket: mine }, OTHER)).toBeNull();
    expect(readComposerPrefill(null, CHAT)).toBeNull();
    expect(readComposerPrefill({ sessionId: CHAT, text: 1, ticket: mine }, CHAT)).toBeNull();
  });

  it("does not append a session that is already in the list", () => {
    const session = { id: CHAT };
    const prev = [session];
    expect(rememberPromptSession(prev, session)).toBeNull();
    expect(prev).toEqual([session]);
    const next = rememberPromptSession(prev, { id: OTHER });
    expect(next).toEqual([session, { id: OTHER }]);
    expect(prev).toEqual([session]);
  });

  it("the latest report replaces the previous one", () => {
    reportThreadLink("First");
    reportThreadLink("");
    expect(threadLinkNotice()?.message).toBe("First");
    reportThreadLink("Second");
    expect(threadLinkNotice()?.message).toBe("Second");
  });
});
