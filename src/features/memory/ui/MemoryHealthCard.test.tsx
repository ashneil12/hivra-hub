// WP-100: the health card says what memory has been doing, in plain words.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { MemoryHealthView } from "../model/health";
import { MemoryHealthCard } from "./MemoryHealthCard";

const NOW = Date.parse("2026-06-01T12:00:00Z");

function view(extra: Partial<MemoryHealthView> = {}): MemoryHealthView {
  return {
    turns: 0,
    stored: 0,
    deferred: 0,
    dropped: { late: 0, secret: 0, ungrounded: 0, invalid: 0, orders: 0, forgotten: 0 },
    fading: 0,
    asksWaiting: 0,
    ...extra,
  };
}

function html(health: MemoryHealthView, paused?: { problem: "hour" | "day"; until: number }): string {
  return renderToStaticMarkup(createElement(MemoryHealthCard, { health, now: NOW, paused }));
}

it("says memory has not been looked at yet on a fresh setup", () => {
  const text = html(view());
  expect(text).toContain("Memory has not been looked at yet.");
  expect(text).toContain("No chat has been looked at yet.");
  expect(text).toContain("Nothing is fading.");
});

it("counts what the curator did, and when it last looked", () => {
  const text = html(
    view({
      turns: 12,
      stored: 4,
      deferred: 2,
      dropped: { late: 1, secret: 3, ungrounded: 2, invalid: 0, orders: 1, forgotten: 0 },
      lastRunAt: NOW - 2 * 3_600_000,
    }),
  );
  expect(text).toContain("Memory was last looked at 2 hours ago.");
  expect(text).toContain("12 chats looked at. 4 facts kept.");
  expect(text).toContain("2 turns were left until later, because the writing side was busy.");
  expect(text).toContain("3 facts were not kept: with a secret in them.");
  expect(text).toContain("2 facts were not kept: not backed by the chat.");
  expect(text).toContain("1 fact was not kept: from a chat that had already moved on.");
  expect(text).toContain("1 fact was not kept: it looks like instructions the person never gave.");
  // A reason with no facts in it is not listed at all.
  expect(text).not.toContain("the curator could not read");
});

it("says what is fading and what is waiting for the person", () => {
  const text = html(view({ fading: 3, asksWaiting: 1 }));
  expect(text).toContain("3 facts are fading from not being used.");
  expect(text).toContain("1 fact is waiting for you to say whether it is still true.");
});

it("says when memory work is paused on the budget, and stays quiet once it has passed", () => {
  const until = new Date(2026, 5, 1, 14, 30).getTime();
  const paused = html(view(), { problem: "hour", until });
  expect(paused).toContain('data-health-paused');
  expect(paused).toContain("Paused until 14:30: the hourly limit was reached.");
  expect(html(view(), { problem: "day", until })).toContain("Paused until 14:30: the daily limit was reached.");
  // Once the moment has passed the line is not shown, and with no pause at all it never appears.
  expect(html(view(), { problem: "hour", until: NOW - 1 })).not.toContain("data-health-paused");
  expect(html(view())).not.toContain("data-health-paused");
});
