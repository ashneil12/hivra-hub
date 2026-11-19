// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import {
  allowsProjectNotification,
  loadNotificationPreferences,
  projectNotificationVerdict,
  updateNotificationPreferences,
  notificationPreferencesSnapshot,
  subscribeNotificationPreferences,
  getProjectNotificationRule,
} from "./notificationPreferences";
import { saveQuietHours } from "./quietHours";

beforeEach(() => localStorage.clear());

it("temporarily silences the whole project and restores only its selected categories at expiry", () => {
  updateNotificationPreferences(["private"], {
    disabled: ["issues", "agentFinished", "agentInput"],
  });
  updateNotificationPreferences(["private"], { mutedUntil: 5000 });
  expect(
    allowsProjectNotification(
      { projectId: "private", category: "pullRequests" },
      4999,
    ),
  ).toBe(false);
  expect(
    allowsProjectNotification(
      { projectId: "work", category: "pullRequests" },
      4999,
    ),
  ).toBe(true);
  expect(
    allowsProjectNotification(
      { projectId: "private", category: "pullRequests" },
      5000,
    ),
  ).toBe(true);
  expect(
    allowsProjectNotification(
      { projectId: "private", category: "issues" },
      5000,
    ),
  ).toBe(false);
});

it("allows an event scheduled exactly at the mute deadline", () => {
  updateNotificationPreferences(["private"], { mutedUntil: 2000 });
  expect(
    allowsProjectNotification(
      { projectId: "private", category: "reminders", occurredAt: 2000 },
      2000,
    ),
  ).toBe(true);
});

it("provides native delivery with the same category and time rule without depending on a running UI timer", () => {
  updateNotificationPreferences(["private"], {
    disabled: ["issues"],
    mutedUntil: 5000,
  });
  expect(getProjectNotificationRule("private", "reminders")).toEqual({
    enabled: true,
    after: 4999,
  });
  expect(getProjectNotificationRule("private", "issues")).toEqual({
    enabled: false,
    after: 4999,
  });
  updateNotificationPreferences(["private"], { mutedUntil: null });
  expect(getProjectNotificationRule("private", "reminders").enabled).toBe(
    false,
  );
});

it("re-enabling one category resumes new events without replaying its delayed history", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  try {
    updateNotificationPreferences(["private"], { disabled: ["issues"] });
    vi.setSystemTime(2000);
    updateNotificationPreferences(["private"], { disabled: [] });
    expect(
      allowsProjectNotification(
        { projectId: "private", category: "issues", occurredAt: 1500 },
        2100,
      ),
    ).toBe(false);
    expect(
      allowsProjectNotification(
        { projectId: "private", category: "pullRequests", occurredAt: 1500 },
        2100,
      ),
    ).toBe(true);
    expect(
      allowsProjectNotification(
        { projectId: "private", category: "issues", occurredAt: 2050 },
        2100,
      ),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("does not replay activity from a mute period when the next refresh arrives after expiry or manual resume", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  try {
    updateNotificationPreferences(["private"], { mutedUntil: 2000 });
    expect(
      allowsProjectNotification(
        { projectId: "private", category: "issues", occurredAt: 1500 },
        2100,
      ),
    ).toBe(false);
    expect(
      allowsProjectNotification(
        { projectId: "private", category: "issues", occurredAt: 2050 },
        2100,
      ),
    ).toBe(true);
    updateNotificationPreferences(["private"], { mutedUntil: null });
    vi.setSystemTime(3000);
    updateNotificationPreferences(["private"], { mutedUntil: undefined });
    expect(
      allowsProjectNotification(
        { projectId: "private", category: "issues", occurredAt: 2900 },
        3100,
      ),
    ).toBe(false);
    expect(
      allowsProjectNotification(
        { projectId: "private", category: "issues", occurredAt: 3050 },
        3100,
      ),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("notifies mounted controls at expiry without a reload and synchronizes changes from another window", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const listener = vi.fn();
  const unsubscribe = subscribeNotificationPreferences(listener);
  try {
    updateNotificationPreferences(["private"], { mutedUntil: 2000 });
    const muted = notificationPreferencesSnapshot();
    listener.mockClear();
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalled();
    expect(notificationPreferencesSnapshot()).not.toBe(muted);
    listener.mockClear();
    window.dispatchEvent(
      new StorageEvent("storage", { key: "monocode.projectNotifications.v1" }),
    );
    expect(listener).toHaveBeenCalled();
  } finally {
    unsubscribe();
    vi.useRealTimers();
  }
});

it("ignores malformed persisted entries without losing valid project choices", () => {
  localStorage.setItem(
    "monocode.projectNotifications.v1",
    JSON.stringify({
      private: {
        disabled: ["issues", "future-category", 5],
        mutedUntil: "forever",
      },
      broken: null,
    }),
  );
  expect(loadNotificationPreferences()).toEqual({
    private: { disabled: ["issues"] },
  });
  expect(
    allowsProjectNotification({ projectId: "broken", category: "issues" }),
  ).toBe(true);
});

it("holds routine categories inside quiet hours, lets approvals through, and lets a mute win", () => {
  const night = new Date(2026, 10, 10, 23, 30).getTime();
  const day = new Date(2026, 10, 10, 12, 0).getTime();
  const subject = (category: "agentFinished" | "agentInput" | "pullRequests" | "issues" | "reminders") => ({
    projectId: "work",
    category,
  });

  expect(allowsProjectNotification(subject("agentFinished"), night)).toBe(true);

  saveQuietHours({ enabled: true, start: "22:00", end: "08:00" });
  for (const category of ["agentFinished", "pullRequests", "issues", "reminders"] as const) {
    expect(projectNotificationVerdict(subject(category), night)).toBe("quiet");
    expect(allowsProjectNotification(subject(category), night)).toBe(false);
    expect(allowsProjectNotification(subject(category), day)).toBe(true);
  }
  expect(projectNotificationVerdict(subject("agentInput"), night)).toBe("allow");
  expect(allowsProjectNotification(subject("agentInput"), night)).toBe(true);

  updateNotificationPreferences(["work"], { disabled: ["agentInput", "issues"] });
  expect(projectNotificationVerdict(subject("agentInput"), night)).toBe("muted");
  expect(projectNotificationVerdict(subject("issues"), night)).toBe("muted");
  expect(projectNotificationVerdict(subject("agentFinished"), night)).toBe("quiet");
});

it("never holds a failure inside quiet hours, whatever its category, and still lets a mute win", () => {
  const night = new Date(2026, 10, 10, 23, 30).getTime();
  saveQuietHours({ enabled: true, start: "22:00", end: "08:00" });
  const failure = (category: "agentFinished" | "pullRequests") => ({ projectId: "work", category, failure: true });

  for (const category of ["agentFinished", "pullRequests"] as const) {
    expect(projectNotificationVerdict({ projectId: "work", category }, night)).toBe("quiet");
    expect(projectNotificationVerdict(failure(category), night)).toBe("allow");
    expect(allowsProjectNotification(failure(category), night)).toBe(true);
  }

  updateNotificationPreferences(["work"], { disabled: ["pullRequests"] });
  expect(projectNotificationVerdict(failure("pullRequests"), night)).toBe("muted");
  expect(projectNotificationVerdict(failure("agentFinished"), night)).toBe("allow");
});
