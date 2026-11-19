import { useEffect, useState } from "react";
import { SwitchRow } from "../../monos/ui/monoPanelParts";
import type { Habit } from "../../monos/model/monoHabits";
import { REPO_WATCH_HABIT_ID, setRepoWatchEnabled } from "../model/habit";

export type RepoWatchHabitSwitchProps = {
  load: () => Promise<readonly Habit[]>;
  update: (change: (habits: readonly Habit[]) => Habit[]) => Promise<void>;
  now?: () => number;
};

function timedOut(error: unknown): boolean {
  return error instanceof Error && /timed out|timeout/i.test(error.message);
}

/** Monday check for pinned repos. Off until the person turns it on. */
export function RepoWatchHabitSwitch({ load, update, now = () => Date.now() }: RepoWatchHabitSwitchProps) {
  const [on, setOn] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void load()
      .then((habits) => {
        if (cancelled) return;
        setOn(habits.some((habit) => habit.id === REPO_WATCH_HABIT_ID && habit.enabled));
        setReady(true);
        setMessage("");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMessage(timedOut(error) ? "Could not read habits this time." : "Could not read habits.");
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function onToggle(next: boolean) {
    const previous = on;
    setOn(next);
    try {
      await update((habits) => setRepoWatchEnabled(habits, next, now()));
      setMessage("");
    } catch (error) {
      setOn(previous);
      setMessage(timedOut(error) ? "Could not save habits this time." : "Could not save habits.");
    }
  }

  return (
    <>
      <SwitchRow
        label="Watch upstream repos"
        description="On Mondays, compare pinned repositories and write what changed. Off until you turn it on."
        on={on}
        disabled={!ready}
        onChange={(next) => void onToggle(next)}
      />
      {message ? <p className="px-3 pb-2 text-[12px] text-content/70">{message}</p> : null}
    </>
  );
}
