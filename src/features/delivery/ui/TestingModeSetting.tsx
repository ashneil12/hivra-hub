// SC-3a: Settings > Crew > "How tasks are tested". One pick-one list per project: when a worker says done, the app tests
// it as far as this says (src-tauri/src/firstmate/testing_mode.rs). In a project it is that project's; from Home there is
// no project in view, so a picker comes first (DESIGN.md rule 8). A late reply never lands on a newer project, a write
// goes on top of the row last read, and a window that read an older row is told so in one grey line.

import { useEffect, useMemo, useRef, useState } from "react";
import { pathKey, projectName } from "../../../shared/lib/paths";
import { SearchableSelect, type SearchableSelectOption } from "../../../shared/ui/SearchableSelect";
import { homeInView } from "../../hub/model/homeScope";
import { IS_HUB_BUNDLE } from "../../hub/model/hubBundle";
import { useHubSelection } from "../../hub/model/hubNav";
import { looksLikeProject, type RecentProject } from "../../projects/model/recents";
import { SettingRow } from "../../settings/ui/SettingRow";
import {
  DEFAULT_TESTING_MODE,
  TESTING_MODES,
  TESTING_MODE_WORDS,
  loadTestingMode,
  saveTestingMode,
  type TestingMode,
  type TestingModeRead,
} from "../model/testingMode";
import {
  SENSITIVE_PATH_GROUPS,
  SENSITIVE_PATHS_ADD_MORE,
  SENSITIVE_PATHS_LINE,
} from "../model/sensitivePaths";

/** The projects a person can pick from Home: the open one first, then the recent ones, each once. */
export function projectChoices(
  project: string,
  recents: readonly Pick<RecentProject, "path">[] | undefined,
): SearchableSelectOption[] {
  const seen = new Set<string>();
  const out: SearchableSelectOption[] = [];
  for (const path of [project, ...(recents ?? []).map((entry) => entry.path)]) {
    if (!path || !looksLikeProject(path)) continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: path, label: projectName(path) });
  }
  return out;
}

function lineOf(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "That didn't go through. Try again.";
}

/** The More text: each built-in group with its patterns in monospace, then where to add more. */
function ProtectedPathsDetails() {
  return (
    <div className="flex flex-col gap-1 break-words">
      {SENSITIVE_PATH_GROUPS.map((group) => (
        <p key={group.id}>
          {group.label}:{" "}
          {group.patterns.map((pattern, i) => (
            <span key={pattern}>
              {i > 0 ? ", " : null}
              <code className="font-mono text-[11px]">{pattern}</code>
            </span>
          ))}
        </p>
      ))}
      <p>{SENSITIVE_PATHS_ADD_MORE}</p>
    </div>
  );
}

export function TestingModeSetting({
  project,
  recents,
  home,
}: {
  /** The open project's folder. Ignored from Home, where the person picks one. */
  project: string;
  recents?: readonly Pick<RecentProject, "path">[];
  /** Whether Home is in view. Left out, it is read from what the app has open. */
  home?: boolean;
}) {
  const selection = useHubSelection();
  const onHome = home ?? (IS_HUB_BUNDLE && homeInView(selection));
  const [picked, setPicked] = useState("");
  const folder = (onHome ? picked : project).trim();
  const choices = useMemo(() => projectChoices(project, recents), [project, recents]);
  const [read, setRead] = useState<TestingModeRead | null>(null);
  const [pending, setPending] = useState<TestingMode | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const gen = useRef(0);
  const folderNow = useRef(folder);
  folderNow.current = folder;

  useEffect(() => {
    const mine = ++gen.current;
    // The last project's choice must not stay on screen while this one loads.
    setRead(null);
    setPending(null);
    setNote(null);
    if (!folder) return;
    loadTestingMode(folder)
      .then((got) => {
        if (mine === gen.current) setRead(got);
      })
      .catch((error: unknown) => {
        if (mine === gen.current) setNote(lineOf(error));
      });
    return () => {
      gen.current += 1;
    };
  }, [folder, again]);

  async function choose(mode: TestingMode) {
    const target = folderNow.current;
    if (!target || !read || pending) return;
    const mine = ++gen.current;
    setPending(mode);
    setNote(null);
    try {
      const saved = await saveTestingMode(target, mode, read.updatedAt);
      if (mine !== gen.current) return;
      setRead(saved);
      setPending(null);
    } catch (error) {
      if (mine !== gen.current) return;
      setPending(null);
      setNote(lineOf(error));
      // The row may have moved in another window: read it again, so what shows is what is stored.
      try {
        const fresh = await loadTestingMode(target);
        if (mine === gen.current) setRead(fresh);
      } catch {
        // The line above already says it didn't go through.
      }
    }
  }

  const name = folder ? projectName(folder) : "";
  const hint = !folder
    ? onHome
      ? "Pick a project to see how its tasks are tested."
      : "Open a project to choose how its tasks are tested."
    : read
      ? `For ${name}. A change applies from the next task that finishes.`
      : note
        ? ""
        : `Reading what ${name} uses.`;

  return (
    <section
      id="setting-testing-mode"
      data-setting-id="testing-mode"
      aria-label="How tasks are tested"
      className="flex flex-col gap-2 border-b border-stroke px-3 py-2"
    >
      <div className="min-w-0">
        <h3 className="text-[13px] font-medium text-content">How tasks are tested</h3>
        {hint ? <p className="mt-0.5 text-[12px] text-content/60">{hint}</p> : null}
      </div>
      {onHome ? (
        <div data-testing-mode-project className="max-w-xs">
          <SearchableSelect
            label="Project"
            value={picked}
            options={choices}
            onChange={setPicked}
            placeholder="Choose a project"
            searchPlaceholder="Search projects…"
            emptyLabel="No projects yet"
          />
        </div>
      ) : null}
      {folder && read ? (
        <div
          role="radiogroup"
          aria-label="How tasks are tested"
          aria-busy={pending !== null}
          className="flex flex-col gap-1.5"
        >
          {TESTING_MODES.map((mode) => {
            const words = TESTING_MODE_WORDS[mode];
            const checked = (pending ?? read.mode) === mode;
            return (
              <label
                key={mode}
                data-testing-mode={mode}
                data-checked={checked ? "true" : "false"}
                className={`flex cursor-pointer items-start gap-2 rounded-md border border-stroke px-3 py-2 ${
                  checked ? "bg-selection" : ""
                } ${pending !== null ? "opacity-70" : ""}`}
              >
                <input
                  type="radio"
                  name="testing-mode"
                  aria-label={words.label}
                  className="mt-0.5 shrink-0"
                  checked={checked}
                  disabled={pending !== null}
                  onChange={() => void choose(mode)}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] text-content">
                    {words.label}
                    {mode === DEFAULT_TESTING_MODE ? (
                      <span className="ml-2 text-[11px] text-content/60">Default</span>
                    ) : null}
                  </span>
                  <span className="text-[12px] text-content/60">{words.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
      {folder && read && read.mode !== "off" ? (
        <div data-testing-mode-protected>
          <SettingRow
            label="Protected changes"
            description={<span className="text-content/60">{SENSITIVE_PATHS_LINE}</span>}
            details={<ProtectedPathsDetails />}
          />
        </div>
      ) : null}
      {note ? (
        <p data-testing-mode-note className="text-[12px] text-content/60">
          {note}
          {!read && folder ? (
            <>
              {" "}
              <button
                type="button"
                data-testing-mode-retry
                className="text-content/80 underline"
                onClick={() => setAgain((n) => n + 1)}
              >
                Try again
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
