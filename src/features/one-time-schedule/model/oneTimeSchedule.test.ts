import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLOSED_APP_WARNING,
  RetryableScheduleError,
  createMemoryOneTimeStore,
  deliverOneTimeSchedule,
  instantFromLocalInput,
  missedScheduleNotice,
  tickOneTimeSchedules,
  type OneTimeSchedule,
} from "./oneTimeSchedule";

const NOW = Date.parse("2026-11-09T09:00:00");
const LATER = "2026-11-09T09:30";

function scheduled(store = createMemoryOneTimeStore(), localText = LATER) {
  return store.create(
    {
      id: "sched-1",
      target: { kind: "chat", sessionId: "chat-1" },
      prompt: "Check the build",
      localText,
    },
    NOW,
  );
}

describe("one-time schedule", () => {
  it("rejects an empty prompt, a bad date, and a time that is not in the future", async () => {
    const store = createMemoryOneTimeStore();
    await expect(
      store.create(
        { target: { kind: "chat", sessionId: "chat-1" }, prompt: "   ", localText: LATER },
        NOW,
      ),
    ).rejects.toThrow(/prompt/i);
    await expect(
      store.create(
        { target: { kind: "chat", sessionId: "chat-1" }, prompt: "Hi", localText: "2026-02-31T12:00" },
        NOW,
      ),
    ).rejects.toThrow(/date/i);
    await expect(
      store.create(
        { target: { kind: "chat", sessionId: "chat-1" }, prompt: "Hi", localText: "2020-01-01T00:00" },
        NOW,
      ),
    ).rejects.toThrow(/future/i);
    expect(instantFromLocalInput("not-a-time")).toBeNull();
    expect(instantFromLocalInput("2026-11-09T09:30")).toBeGreaterThan(0);
  });

  it("persists a schedule across a restart, including unicode, spaces, and CRLF", async () => {
    const store = createMemoryOneTimeStore();
    const saved = await store.create(
      {
        id: "sched-1",
        target: { kind: "project", projectId: "C:\\Work\\My Project\\项目" },
        prompt: "Line one\r\nline two",
        localText: LATER,
      },
      NOW,
    );
    const restored = createMemoryOneTimeStore(store.dump());
    expect(await restored.list()).toEqual([saved]);
    const junk = JSON.parse(store.dump()) as unknown[];
    junk.push({ status: "nope", prompt: "x" });
    const skipped = createMemoryOneTimeStore(JSON.stringify(junk));
    expect(await skipped.list()).toEqual([saved]);
  });

  it("fires while the app is open, and a second claim does not send twice", async () => {
    const store = createMemoryOneTimeStore();
    const row = await scheduled(store);
    const sent: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = (schedule: OneTimeSchedule) => {
      sent.push(schedule.id);
      return gate;
    };
    const first = tickOneTimeSchedules({
      mode: "open",
      now: row.runAt,
      store,
      send,
      tokens: ["token-a", "token-b"],
    });
    const second = tickOneTimeSchedules({
      mode: "open",
      now: row.runAt,
      store,
      send,
      tokens: ["token-b"],
    });
    release();
    await Promise.all([first, second]);
    expect(sent).toEqual(["sched-1"]);
    expect((await store.list())[0]?.status).toBe("fired");
  });

  it("leaves the run scheduled when sending times out, then fires on the next try", async () => {
    const store = createMemoryOneTimeStore();
    const row = await scheduled(store);
    await tickOneTimeSchedules({
      mode: "open",
      now: row.runAt,
      store,
      send: async () => {
        throw new RetryableScheduleError("timed out");
      },
      tokens: ["token-a"],
    });
    expect((await store.list())[0]?.status).toBe("scheduled");
    expect((await store.list())[0]?.claim).toBeUndefined();
    const sent: string[] = [];
    await tickOneTimeSchedules({
      mode: "open",
      now: row.runAt + 1,
      store,
      send: async (schedule) => {
        sent.push(schedule.prompt);
      },
      tokens: ["token-b"],
    });
    expect(sent).toEqual(["Check the build"]);
    expect((await store.list())[0]?.status).toBe("fired");
  });

  it("cancels a scheduled run and leaves a fired or missed run alone", async () => {
    const store = createMemoryOneTimeStore();
    await scheduled(store);
    const cancelled = await store.cancel("sched-1", NOW + 1);
    expect(cancelled.status).toBe("cancelled");
    expect((await store.cancel("sched-1", NOW + 2)).status).toBe("cancelled");

    const again = createMemoryOneTimeStore();
    const row = await scheduled(again);
    await tickOneTimeSchedules({
      mode: "open",
      now: row.runAt,
      store: again,
      send: async () => undefined,
      tokens: ["token-a"],
    });
    expect((await again.cancel("sched-1", row.runAt + 1)).status).toBe("fired");
  });

  it("marks a due run missed when the process starts after the time, and says so once", async () => {
    const store = createMemoryOneTimeStore();
    const row = await scheduled(store);
    const closed = createMemoryOneTimeStore(store.dump());
    const first = await tickOneTimeSchedules({
      mode: "launch",
      now: row.runAt + 60_000,
      store: closed,
      send: async () => {
        throw new Error("must not send");
      },
    });
    expect((await closed.list())[0]?.status).toBe("missed");
    expect(first.notices.map((notice) => notice.text).join("\n")).toContain(
      "Hivra was closed",
    );
    expect(first.notices[0]?.text).toBe(
      missedScheduleNotice((await closed.list())[0]!),
    );
    await closed.note(first.notices[0]!.id, row.runAt + 61_000);
    const second = await tickOneTimeSchedules({
      mode: "launch",
      now: row.runAt + 62_000,
      store: closed,
      send: async () => undefined,
    });
    expect(second.notices).toEqual([]);
    expect((await closed.cancel("sched-1", row.runAt + 63_000)).status).toBe("missed");
  });

  it("does not mark a later run missed just because a second window opened", async () => {
    const store = createMemoryOneTimeStore();
    const row = await scheduled(store);
    await tickOneTimeSchedules({ mode: "launch", now: NOW, store, send: async () => undefined });
    const due = row.runAt;
    const sent: string[] = [];
    await tickOneTimeSchedules({
      mode: "launch",
      now: due,
      store,
      send: async () => {
        sent.push("launch");
      },
    });
    expect((await store.list())[0]?.status).toBe("scheduled");
    await tickOneTimeSchedules({
      mode: "open",
      now: due,
      store,
      send: async () => {
        sent.push("open");
      },
      tokens: ["token-a"],
    });
    expect(sent).toEqual(["open"]);
    expect((await store.list())[0]?.status).toBe("fired");
  });

  it("does not send a second prompt when the first result arrives late", async () => {
    const store = createMemoryOneTimeStore();
    const row = await scheduled(store);
    const claimed = await store.claim("sched-1", row.updatedAt, "token-a", row.runAt + 1_000, row.runAt);
    expect(claimed?.claim?.token).toBe("token-a");
    await store.release("sched-1", "token-a", row.runAt + 1);
    const replacement = await store.list();
    const next = await store.claim(
      "sched-1",
      replacement[0]!.updatedAt,
      "token-b",
      row.runAt + 5_000,
      row.runAt + 2,
    );
    expect(await store.ackFired("sched-1", "token-a", row.runAt + 3)).toBeNull();
    expect(next?.status).toBe("scheduled");
    const fired = await store.ackFired("sched-1", "token-b", row.runAt + 4);
    expect(fired?.status).toBe("fired");
  });

  it("gives each claim its own token, so a stale runner's release leaves a later claim alone", async () => {
    // The app's runner passes no tokens. Two runners (a reload after a claim expired) must not share one.
    const store = createMemoryOneTimeStore();
    const row = await scheduled(store);
    let failFirst: (error: Error) => void = () => undefined;
    const first = tickOneTimeSchedules({
      mode: "open",
      now: row.runAt,
      store,
      claimHoldMs: 1_000,
      send: () => new Promise<void>((_resolve, reject) => (failFirst = reject)),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = tickOneTimeSchedules({
      mode: "open",
      now: row.runAt + 2_000,
      store,
      claimHoldMs: 60_000,
      send: () => new Promise<void>(() => undefined),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const held = (await store.list())[0]?.claim?.token;
    expect(held).toBeTruthy();
    failFirst(new RetryableScheduleError("That chat is busy."));
    await first;
    expect((await store.list())[0]?.claim?.token).toBe(held);
    void second;
  });

  it("sends a project run in a new chat, and reuses that chat if the send has to retry", async () => {
    const store = createMemoryOneTimeStore();
    const row = await store.create(
      {
        id: "sched-1",
        target: { kind: "project", projectId: "/work/demo" },
        prompt: "Open the notes",
        localText: LATER,
      },
      NOW,
    );
    const created: string[] = [];
    const submitted: string[] = [];
    let chats: { id: string; busy: boolean }[] = [];
    const deliver = (schedule: OneTimeSchedule) =>
      deliverOneTimeSchedule(schedule, {
        findChat: (id) => chats.find((chat) => chat.id === id) ?? null,
        findProject: (id) => (id === "/work/demo" ? { folder: "/work/demo" } : null),
        createChat: async (folder) => {
          created.push(folder);
          chats = [{ id: "new-chat", busy: false }];
          return "new-chat";
        },
        rememberSession: (current, sessionId) =>
          store.rememberSession(current.id, current.claim!.token, sessionId, NOW),
        submit: async (sessionId, prompt) => {
          submitted.push(`${sessionId}:${prompt}`);
          if (submitted.length === 1) throw new RetryableScheduleError("timed out");
          return true;
        },
      });
    await tickOneTimeSchedules({
      mode: "open",
      now: row.runAt,
      store,
      send: deliver,
      tokens: ["token-a"],
    });
    expect(created).toEqual(["/work/demo"]);
    expect((await store.list())[0]?.status).toBe("scheduled");
    expect((await store.list())[0]?.startedSessionId).toBe("new-chat");
    await tickOneTimeSchedules({
      mode: "open",
      now: row.runAt + 1,
      store,
      send: deliver,
      tokens: ["token-b"],
    });
    expect(created).toEqual(["/work/demo"]);
    expect(submitted).toEqual(["new-chat:Open the notes", "new-chat:Open the notes"]);
    expect((await store.list())[0]?.status).toBe("fired");
  });

  it("does not start a chat for a project path that is not one of the known projects", async () => {
    const store = createMemoryOneTimeStore();
    const row = await store.create(
      {
        id: "sched-1",
        target: { kind: "project", projectId: "../outside" },
        prompt: "No",
        localText: LATER,
      },
      NOW,
    );
    const created: string[] = [];
    await tickOneTimeSchedules({
      mode: "open",
      now: row.runAt,
      store,
      send: (schedule) =>
        deliverOneTimeSchedule(schedule, {
          findChat: () => null,
          findProject: () => null,
          createChat: async (folder) => {
            created.push(folder);
            return "nope";
          },
          rememberSession: async () => null,
          submit: async () => true,
        }),
      tokens: ["token-a"],
    });
    expect(created).toEqual([]);
    expect((await store.list())[0]?.status).toBe("scheduled");
  });

  it("waits when the chat is busy instead of treating that as the scheduled run", async () => {
    const store = createMemoryOneTimeStore();
    const row = await scheduled(store);
    const submitted: string[] = [];
    await tickOneTimeSchedules({
      mode: "open",
      now: row.runAt,
      store,
      send: (schedule) =>
        deliverOneTimeSchedule(schedule, {
          findChat: () => ({ id: "chat-1", busy: true }),
          findProject: () => null,
          createChat: async () => "nope",
          rememberSession: async () => null,
          submit: async (_id, prompt) => {
            submitted.push(prompt);
            return true;
          },
        }),
      tokens: ["token-a"],
    });
    expect(submitted).toEqual([]);
    expect((await store.list())[0]?.status).toBe("scheduled");
  });

  it("tells the person a closed app will miss the run, and installs no background service", () => {
    expect(CLOSED_APP_WARNING).toBe(
      "Hivra only runs this while it is open. If Hivra is closed at this time, the run is missed.",
    );
    expect(CLOSED_APP_WARNING).not.toMatch(/[—–]/);
    const files = [
      "src-tauri/src/one_time_schedule.rs",
      "src/features/one-time-schedule/model/oneTimeSchedule.ts",
      "src/features/one-time-schedule/model/oneTimeScheduleApi.ts",
      "src/features/one-time-schedule/ui/OneTimeSchedulePanel.tsx",
      "src/features/one-time-schedule/ui/useOneTimeScheduleRunner.ts",
    ];
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/LaunchAgent|systemd|launchctl|osascript/);
  });
});
