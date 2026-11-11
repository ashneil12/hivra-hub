// WP-104: the health list on Settings. A later failure keeps the last rows. A late result cannot overwrite a newer one.

import { useEffect, useRef, useState } from "react";
import {
  HEALTH_REFRESH_MS,
  healthLine,
  healthRows,
  toneLabel,
  type HealthFacts,
  type HealthRow,
} from "../model/health";

const FIRST_MISS = "Couldn't check just now. It will try again.";
const REFRESH_MISS = "Couldn't refresh just now. Showing the last check.";

export function HealthList({
  rows,
  pending = false,
  note = "",
}: {
  rows: readonly HealthRow[];
  pending?: boolean;
  note?: string;
}) {
  return (
    <section className="mt-8 flex flex-col gap-2" aria-label="Health">
      <h2 className="text-sm font-medium">Health</h2>
      <p className="text-sm text-content/70">
        A check of this Mac. It runs when you open this page and every 15 minutes while you stay here.
      </p>
      {note ? (
        <p className="text-sm" role="status">
          {note}
        </p>
      ) : null}
      {pending && rows.length === 0 ? (
        <p className="text-sm" role="status">
          Checking.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.id} data-tone={row.tone} className="text-sm">
              {toneLabel(row.tone)}. {row.text}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function useHealth(load: () => Promise<HealthFacts>, intervalMs = HEALTH_REFRESH_MS) {
  const [rows, setRows] = useState<HealthRow[]>([]);
  const [pending, setPending] = useState(true);
  const [note, setNote] = useState("");
  const had = useRef(false);
  const started = useRef(0);
  const applied = useRef(0);

  useEffect(() => {
    let alive = true;
    started.current = 0;
    applied.current = 0;
    const wait = Number.isFinite(intervalMs) && intervalMs >= 50 ? intervalMs : HEALTH_REFRESH_MS;
    const run = () => {
      const mine = ++started.current;
      void load()
        .then((facts) => {
          if (!alive || mine < applied.current) return;
          applied.current = mine;
          const next = healthRows(facts);
          had.current = next.length > 0;
          setRows(next);
          setPending(false);
          setNote("");
        })
        .catch(() => {
          if (!alive || mine !== started.current || mine < applied.current) return;
          setPending(false);
          setNote(had.current ? REFRESH_MISS : FIRST_MISS);
        });
    };
    run();
    const timer = window.setInterval(run, wait);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [load, intervalMs]);

  return { rows, pending, note, lines: rows.map(healthLine) };
}
