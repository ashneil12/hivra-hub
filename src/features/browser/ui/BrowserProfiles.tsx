// WP-43. Each agent keeps its own browser profile. A folder the person chose is never deleted from here.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { takeLatest } from "../model/latest";

type Profile = { id: string; name: string; watch: boolean; own: boolean; path: string };

const BTN =
  "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";

function note(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The browser profiles couldn't be read. Try again.";
}

/** The installed-plugins list of browser profiles. A late reply never overwrites a newer one. */
export function BrowserProfiles() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const ticket = useRef(0);

  const apply = useCallback((asked: number, next: Profile[] | undefined, problem: string | null) => {
    if (takeLatest(asked, ticket.current, true) === undefined) return;
    if (next) setProfiles(next);
    setError(problem);
  }, []);

  const load = useCallback(() => {
    const asked = ++ticket.current;
    invoke<Profile[]>("browser_profiles")
      .then((value) => apply(asked, Array.isArray(value) ? value : [], null))
      .catch((reason) => apply(asked, undefined, note(reason)));
  }, [apply]);

  useEffect(() => {
    load();
  }, [load]);

  const ask = (command: string, args: Record<string, unknown>) => {
    const asked = ++ticket.current;
    invoke<Profile[]>(command, args)
      .then((value) => apply(asked, Array.isArray(value) ? value : [], null))
      .catch((reason) => apply(asked, undefined, note(reason)));
  };

  const useFolder = (id: string) => {
    const path = folder.trim();
    if (!path) {
      setHint("Choose a folder first.");
      return;
    }
    setHint(null);
    ask("browser_choose_own", { agentId: id, path });
  };

  return (
    <section aria-label="Browser profiles" className="mt-6 flex flex-col gap-3">
      <h3 className="text-[13px] font-medium text-content">Browser profiles</h3>
      <p className="text-[13px] text-content/70">Each agent keeps its own logins here, not in your browser.</p>
      {error ? <p className="text-[13px] text-content/70">{error}</p> : null}
      {profiles.length === 0 ? <p className="text-[13px] text-content/50">No browser profiles yet.</p> : null}
      <ul className="flex flex-col gap-3">
        {profiles.map((profile) => (
          <li key={profile.id} data-profile={profile.id} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-content">{profile.name}</span>
              <button type="button" className={BTN} onClick={() => ask("browser_clear", { agentId: profile.id })}>
                Clear
              </button>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={profile.watch}
              aria-label={`Show the browser while ${profile.name} uses it`}
              className={BTN}
              onClick={() => ask("browser_watch", { agentId: profile.id, watch: !profile.watch })}
            >
              Show the browser while this agent uses it
            </button>
            {profile.own ? (
              <p className="text-[13px] text-content/70">
                This is a folder you chose. Clear forgets that choice and does not delete the folder.
              </p>
            ) : null}
            {open === profile.id ? (
              <div className="flex items-center gap-2">
                <input
                  aria-label="Folder"
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                  className="min-w-0 flex-1 rounded-md bg-content/8 px-2 py-1 text-xs text-content"
                />
                <button type="button" className={BTN} onClick={() => useFolder(profile.id)}>
                  Use this folder
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={BTN}
                onClick={() => {
                  setOpen(profile.id);
                  setFolder("");
                  setHint(null);
                }}
              >
                Use another folder
              </button>
            )}
            {open === profile.id && hint ? <p className="text-[13px] text-content/70">{hint}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
