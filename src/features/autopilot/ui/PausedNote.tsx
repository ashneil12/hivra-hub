import { pausedFor, usePausedVersion } from "../model/paused";

/** " · Paused until 14:10" after a Mono's name while it waits out a usage limit it resumes from by itself. */
export function PausedNote({ who }: { who: string }) {
  usePausedVersion();
  const label = pausedFor(who);
  return label ? <span data-autopilot-paused className="text-content/45"> · {label}</span> : null;
}
