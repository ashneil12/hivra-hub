// WP-43. While a browser is showing, Stop stays on screen. Headless sessions are not listed.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { takeLatest } from "../model/latest";

type Drive = { id: string; agentId: string; name: string };

const BTN =
  "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";

function note(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The browser didn't answer. Try again.";
}

/** The browsers that are showing, and Stop. Nothing outside the app, and nothing when none are showing. */
export function DrivingBar() {
  const live = isTauri();
  const [drives, setDrives] = useState<Drive[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);

  const apply = useCallback((asked: number, next: Drive[] | undefined, problem: string | null) => {
    if (takeLatest(asked, ticket.current, true) === undefined) return;
    if (next) setDrives(next);
    setError(problem);
  }, []);

  const load = useCallback(() => {
    const asked = ++ticket.current;
    invoke<Drive[]>("browser_drives")
      .then((value) => apply(asked, Array.isArray(value) ? value : [], null))
      .catch((reason) => apply(asked, undefined, note(reason)));
  }, [apply]);

  useEffect(() => {
    if (!live) return;
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [live, load]);

  const run = (command: "browser_stop" | "browser_stop_all", args: Record<string, unknown>) => {
    const asked = ++ticket.current;
    invoke(command, args)
      .then(() => invoke<Drive[]>("browser_drives"))
      .then((value) => apply(asked, Array.isArray(value) ? value : [], null))
      .catch((reason) => apply(asked, undefined, note(reason)));
  };

  if (!live || (drives.length === 0 && !error)) return null;
  return (
    <section aria-label="Browser in use" className="flex flex-col gap-2 border-b border-content/10 px-3 py-2">
      {drives.map((drive) => (
        <div key={drive.id} data-drive={drive.id} className="flex items-center justify-between gap-3">
          <p className="text-[13px] text-content">{drive.name} is using the browser</p>
          <button type="button" className={BTN} onClick={() => run("browser_stop", { id: drive.id })}>
            Stop
          </button>
        </div>
      ))}
      {drives.length > 1 ? (
        <button type="button" className={BTN} onClick={() => run("browser_stop_all", {})}>
          Stop all
        </button>
      ) : null}
      {error ? <p className="text-[13px] text-content/70">{error}</p> : null}
    </section>
  );
}
