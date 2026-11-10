// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  announceSessionFinished,
  announceSessionInput,
  notifySession,
  saveNotificationsEnabled,
  setWindowFocused,
} from "./notifications";
import { updateNotificationPreferences } from "./notificationPreferences";
import { flushNotableDue } from "./notableDelivery";
import { readNotableBuffer } from "./notableEvents";
import { saveQuietHours } from "./quietHours";
import { newSession } from "../../sessions/model/session";

const { invoke, play } = vi.hoisted(() => ({ invoke: vi.fn(), play: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("cuelume", () => ({ play, setEnabled: vi.fn(), setVolume: vi.fn() }));
beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  play.mockClear();
  invoke.mockResolvedValue(undefined);
  saveNotificationsEnabled(true);
  setWindowFocused(false);
});

it("returns false without a banner or sound for a non-project path", async () => {
  const sent = await notifySession(
    newSession("claude", "/"),
    "finished",
    false,
  );

  expect(sent).toBe(false);
  expect(
    invoke.mock.calls.filter(([command]) => command === "show_notification"),
  ).toEqual([]);
  expect(play).not.toHaveBeenCalled();
});

it("finishes without a banner or sound for a non-project path", async () => {
  await expect(
    announceSessionFinished(
      newSession("claude", "/"),
      false,
    ),
  ).resolves.toBeUndefined();

  expect(
    invoke.mock.calls.filter(([command]) => command === "show_notification"),
  ).toEqual([]);
  expect(play).not.toHaveBeenCalled();
});

it("blocks every project banner, including approvals and questions, while muted", async () => {
  updateNotificationPreferences(["local:/private"], {
    mutedUntil: null,
  });
  const session = newSession("claude", "/private");
  expect(await notifySession(session, "finished", false)).toBe(false);
  expect(
    await notifySession(session, { kind: "approval", requestId: 1 }, false),
  ).toBe(false);
  expect(
    await notifySession(session, { kind: "question", requestId: 2 }, false),
  ).toBe(false);
  expect(
    invoke.mock.calls.filter(([command]) => command === "show_notification"),
  ).toEqual([]);
});

it("does not deliver an input event observed during a mute after expiry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  try {
    updateNotificationPreferences(["local:/private"], {
      mutedUntil: 2000,
    });
    const sent = notifySession(
      newSession("claude", "/private"),
      { kind: "question", requestId: 1 },
      false,
    );
    vi.setSystemTime(3000);
    expect(await sent).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("plays the input cue only when the question banner is not sent", async () => {
  const session = newSession("claude", "/work");
  const event = { kind: "question" as const, requestId: 1 };
  await announceSessionInput(session, event, false);
  expect(play).not.toHaveBeenCalled();

  invoke.mockRejectedValue(new Error("No native bridge"));
  await announceSessionInput(session, event, false);
  expect(play.mock.calls).toEqual([["arrival"]]);

  updateNotificationPreferences(["local:/work"], { mutedUntil: null });
  await announceSessionInput(session, event, false);
  expect(play).toHaveBeenCalledTimes(1);
});

describe("quiet hours on the notice path", () => {
  const overnight = { enabled: true, start: "22:00", end: "08:00" };
  const at = (hour: number, minute = 0, day = 10) =>
    new Date(2026, 10, day, hour, minute, 30).getTime();
  const banners = () =>
    invoke.mock.calls.filter(([command]) => command === "show_notification");

  beforeEach(() => {
    vi.useFakeTimers();
    saveQuietHours(overnight);
  });
  afterEach(() => vi.useRealTimers());

  it("holds a finished-agent banner and its sound overnight, then sends one ping when the window ends", async () => {
    vi.setSystemTime(at(23, 30));
    const session = newSession("claude", "/work");
    await announceSessionFinished(session, false);
    expect(banners()).toEqual([]);
    expect(play).not.toHaveBeenCalled();
    expect(readNotableBuffer().pending.map((held) => held.kind)).toEqual(["held"]);

    vi.setSystemTime(at(7, 59, 11));
    expect(await flushNotableDue()).toBeNull();
    expect(banners()).toEqual([]);

    vi.setSystemTime(at(8, 0, 11));
    expect(await flushNotableDue()).toBe("shown");
    expect(banners()).toHaveLength(1);
    expect(banners()[0][1]).toMatchObject({
      title: "MonoCode",
      subtitle: "While you were away",
    });
    expect(readNotableBuffer().pending).toEqual([]);
    expect(await flushNotableDue()).toBeNull();
  });

  it("still shows approvals and questions overnight, and sends nothing extra at the end", async () => {
    vi.setSystemTime(at(23, 30));
    const session = newSession("claude", "/work");
    await announceSessionInput(session, { kind: "question", requestId: 1 }, false);
    expect(banners()).toHaveLength(1);
    expect(readNotableBuffer().pending).toEqual([]);
  });

  it("shows a turn that failed overnight at once, as a failure, and does not hold it like a success", async () => {
    vi.setSystemTime(at(23, 30));
    const session = newSession("claude", "/work");
    await announceSessionFinished(session, false, true);
    expect(banners()).toHaveLength(1);
    expect(banners()[0][1]).toMatchObject({ title: "MonoCode", body: "Claude Code stopped with an error" });
    expect(readNotableBuffer().pending).toEqual([]);

    // With the banner off, the failure still gets its sound; a success would have been silent all night.
    saveNotificationsEnabled(false);
    await announceSessionFinished(session, false, true);
    expect(play).toHaveBeenCalledTimes(1);
    play.mockClear();
    await announceSessionFinished(session, false);
    expect(play).not.toHaveBeenCalled();
  });

  it("lets a mute win over a failed turn, at any hour", async () => {
    vi.setSystemTime(at(23, 30));
    updateNotificationPreferences(["local:/muted"], { disabled: ["agentFinished"] });
    await announceSessionFinished(newSession("claude", "/muted"), false, true);
    expect(banners()).toEqual([]);
    expect(play).not.toHaveBeenCalled();
    expect(readNotableBuffer().pending).toEqual([]);
  });

  it("shows a finished-agent banner in the daytime", async () => {
    vi.setSystemTime(at(12, 0));
    await announceSessionFinished(newSession("claude", "/work"), false);
    expect(banners()).toHaveLength(1);
    expect(readNotableBuffer().pending).toEqual([]);
  });

  it("does not hold what was already muted, or what no banner would have shown", async () => {
    vi.setSystemTime(at(23, 30));
    updateNotificationPreferences(["local:/muted"], { disabled: ["agentFinished"] });
    await announceSessionFinished(newSession("claude", "/muted"), false);
    expect(readNotableBuffer().pending).toEqual([]);

    const session = newSession("claude", "/work");
    saveNotificationsEnabled(false);
    await announceSessionFinished(session, false);
    expect(readNotableBuffer().pending).toEqual([]);

    saveNotificationsEnabled(true);
    setWindowFocused(true);
    await announceSessionFinished(session, true);
    expect(readNotableBuffer().pending).toEqual([]);
    expect(banners()).toEqual([]);
  });
});
