// WP-100: a small card at the top of the Memory screen. Plain numbers: what the curator did, when it last looked,
// what is fading, and what is waiting for the person.

import type { MemoryHealthView } from "../model/health";
import type { BudgetPause } from "../model/memoryBudget";
import { pausedText } from "../model/memoryBudget";

const DROP_NAMES: Array<{ key: keyof MemoryHealthView["dropped"]; label: string }> = [
  { key: "secret", label: "with a secret in them" },
  { key: "ungrounded", label: "not backed by the chat" },
  { key: "late", label: "from a chat that had already moved on" },
  { key: "invalid", label: "the curator could not read" },
  { key: "orders", label: "it looks like instructions the person never gave" },
];

function when(at: number | undefined, now: number): string {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return "Memory has not been looked at yet.";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "Memory was last looked at just now.";
  if (minutes < 60) return `Memory was last looked at ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Memory was last looked at ${hours} ${hours === 1 ? "hour" : "hours"} ago.`;
  const days = Math.floor(hours / 24);
  return `Memory was last looked at ${days} ${days === 1 ? "day" : "days"} ago.`;
}

export function MemoryHealthCard({ health, now, paused }: { health: MemoryHealthView; now: number; paused?: BudgetPause }) {
  const dropped = DROP_NAMES.filter((row) => health.dropped[row.key] > 0);
  return (
    <section aria-label="Memory health" className="flex flex-col gap-1 rounded-md border border-content/15 p-3 text-sm">
      <p data-health-last-run>{when(health.lastRunAt, now)}</p>
      {paused && paused.until > now ? <p data-health-paused>{pausedText(paused.problem, paused.until)}</p> : null}
      <p data-health-turns>
        {health.turns === 0
          ? "No chat has been looked at yet."
          : `${health.turns} ${health.turns === 1 ? "chat" : "chats"} looked at. ${health.stored} ${health.stored === 1 ? "fact" : "facts"} kept.`}
      </p>
      {health.deferred > 0 ? (
        <p data-health-deferred>
          {`${health.deferred} ${health.deferred === 1 ? "turn was" : "turns were"} left until later, because the writing side was busy.`}
        </p>
      ) : null}
      {dropped.map((row) => (
        <p key={row.key} data-health-dropped={row.key}>
          {`${health.dropped[row.key]} ${health.dropped[row.key] === 1 ? "fact was" : "facts were"} not kept: ${row.label}.`}
        </p>
      ))}
      <p data-health-fading>
        {health.fading === 0
          ? "Nothing is fading."
          : `${health.fading} ${health.fading === 1 ? "fact is" : "facts are"} fading from not being used.`}
      </p>
      {health.asksWaiting > 0 ? (
        <p data-health-asks>
          {`${health.asksWaiting} ${health.asksWaiting === 1 ? "fact is" : "facts are"} waiting for you to say whether ${health.asksWaiting === 1 ? "it is" : "they are"} still true.`}
        </p>
      ) : null}
    </section>
  );
}
