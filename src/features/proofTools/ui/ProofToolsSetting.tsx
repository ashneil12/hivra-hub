// PT-2: Settings > Crew > "Proof tools", under "How tasks are tested". One row per open-source proof tool that fits the project
// (src-tauri/src/proof_tools): what it proves, whether the project has it, and a per-project switch for a tool it has. An off tool
// never runs for that project (the gate, the ship check, a brief, the checker's replay) and is never proposed.
//
// The project-in-view rule is TestingModeSetting's: in a project it is that project's; from Home there is no project in view, so
// a picker comes first and nothing is read until one is picked (DESIGN.md rule 8). A late reply never lands on a newer project, a
// write goes on top of the revision last read, and a window that read an older one is told so in one grey line and reads again.

import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { projectName } from "../../../shared/lib/paths";
import { Popover } from "../../../shared/ui/Popover";
import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { projectChoices } from "../../delivery/ui/TestingModeSetting";
import { homeInView } from "../../hub/model/homeScope";
import { IS_HUB_BUNDLE } from "../../hub/model/hubBundle";
import { useHubSelection } from "../../hub/model/hubNav";
import type { RecentProject } from "../../projects/model/recents";
import { SettingSwitch } from "../../settings/ui/SettingRow";
import { findProofTool, type ProofToolList, type ProofToolView } from "../model/proofTools";
import {
  NONE_FIT_LINE,
  PROOF_TOOLS_HINT,
  PROOF_TOOLS_TRY_AGAIN,
  applySwitches,
  loadProofTools,
  moreLines,
  setProofTool,
  stateWord,
  tagOf,
} from "../model/proofToolsSettings";

const QUIET = "text-[12px] text-content/60";

/** What the model threw: it already holds the line to show. */
function lineOf(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : PROOF_TOOLS_TRY_AGAIN;
}

export function ProofToolsSetting({
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
  const [list, setList] = useState<ProofToolList | null>(null);
  /** The tool whose switch write is out. */
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const gen = useRef(0);
  const folderNow = useRef(folder);
  folderNow.current = folder;

  useEffect(() => {
    const mine = ++gen.current;
    // The last project's tools must not stay on screen while this one loads.
    setList(null);
    setPending(null);
    setNote(null);
    if (!folder) return;
    loadProofTools(folder)
      .then((got) => {
        if (mine === gen.current) setList(got);
      })
      .catch((error: unknown) => {
        if (mine === gen.current) setNote(lineOf(error));
      });
    return () => {
      gen.current += 1;
    };
  }, [folder, again]);

  async function flip(tool: ProofToolView) {
    const target = folderNow.current;
    if (!target || !list || pending) return;
    const mine = ++gen.current;
    setPending(tool.id);
    setNote(null);
    try {
      // `on` is the position the switch is going to: a tool that is off is being turned on.
      const saved = await setProofTool(target, tool.id, tool.off, list.revision);
      if (mine !== gen.current) return;
      setList((now) => (now ? applySwitches(now, saved) : now));
      setPending(null);
    } catch (error) {
      if (mine !== gen.current) return;
      setPending(null);
      setNote(lineOf(error));
      // The record may have moved in another window: read it again, so what shows is what is stored.
      try {
        const fresh = await loadProofTools(target);
        if (mine === gen.current) setList(fresh);
      } catch {
        // The line above already says it didn't go through.
      }
    }
  }

  const name = folder ? projectName(folder) : "";
  const status = !folder
    ? onHome
      ? "Pick a project to see which of these tools fit it."
      : "Open a project to see which of these tools fit it."
    : list
      ? `For ${name}.`
      : note
        ? ""
        : `Reading what ${name} has.`;

  return (
    <section
      id="setting-proof-tools"
      data-setting-id="proof-tools"
      aria-label="Proof tools"
      className="flex flex-col gap-2 border-b border-stroke px-3 py-2"
    >
      <div className="min-w-0">
        <h3 className="text-[13px] font-medium text-content">Proof tools</h3>
        <p data-proof-tools-hint className={`mt-0.5 ${QUIET}`}>
          {PROOF_TOOLS_HINT}
        </p>
        {status ? (
          <p data-proof-tools-status className={`mt-0.5 ${QUIET}`}>
            {status}
          </p>
        ) : null}
      </div>
      {onHome ? (
        <div data-proof-tools-project className="max-w-xs">
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
      {folder && list ? (
        list.tools.length === 0 ? (
          <p data-proof-tools-none className={QUIET}>
            {NONE_FIT_LINE}
          </p>
        ) : (
          <ul aria-busy={pending !== null} className="flex flex-col">
            {list.tools.map((tool) => (
              <ToolRow
                key={tool.id}
                tool={tool}
                pending={pending}
                onFlip={() => void flip(tool)}
                onTrouble={setNote}
              />
            ))}
          </ul>
        )
      ) : null}
      {note ? (
        <p data-proof-tools-note className={QUIET}>
          {note}
          {!list && folder ? (
            <>
              {" "}
              <button
                type="button"
                data-proof-tools-retry
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

function ToolRow({
  tool,
  pending,
  onFlip,
  onTrouble,
}: {
  tool: ProofToolView;
  pending: string | null;
  onFlip: () => void;
  onTrouble: (line: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const tag = tagOf(tool);
  // While this tool's write is out its switch already shows where it is going.
  const used = tool.installed && (pending === tool.id ? tool.off : !tool.off);
  return (
    <li
      data-proof-tool={tool.id}
      className="flex items-start gap-3 border-t border-content/5 py-2 first:border-t-0"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-content">
          {tool.name}
          {tag ? (
            <span data-proof-tool-tag className="ml-2 text-[11px] text-content/60">
              {tag}
            </span>
          ) : null}
        </p>
        <p className={`mt-0.5 ${QUIET}`}>{tool.proves}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span data-proof-tool-state={tool.id} className={`min-w-24 text-right ${QUIET}`}>
          {stateWord(tool)}
        </span>
        {tool.installed ? (
          <SettingSwitch
            label={`Use ${tool.name} in this project`}
            on={used}
            disabled={pending !== null}
            onChange={onFlip}
            dataProps={{ "data-proof-tool-switch": tool.id }}
          />
        ) : (
          <span aria-hidden className="w-9 shrink-0" />
        )}
        <button
          ref={moreButton}
          type="button"
          data-proof-tool-more={tool.id}
          aria-expanded={open}
          onClick={() => setOpen((now) => !now)}
          className="text-[12px] text-content/60 underline-offset-2 hover:text-content hover:underline"
        >
          More
        </button>
      </div>
      {open ? (
        <Popover
          anchor={moreButton}
          side="bottom"
          align="end"
          width={320}
          onDismiss={() => setOpen(false)}
          role="dialog"
          aria-label={`About ${tool.name}`}
          data-proof-tool-details={tool.id}
          className="solid-panel-glass flex flex-col gap-1.5 p-3 font-sans text-[12px] text-content"
        >
          <MoreBody tool={tool} onTrouble={onTrouble} />
        </Popover>
      ) : null}
    </li>
  );
}

function MoreBody({ tool, onTrouble }: { tool: ProofToolView; onTrouble: (line: string) => void }) {
  // Every word is the catalogue's, never the app's answer.
  const known = findProofTool(tool.id);
  if (!known) return null;
  const lines = moreLines(known, tool.installed);
  return (
    <>
      <p data-proof-tool-licence>{lines.licence}</p>
      <p>
        <button
          type="button"
          data-proof-tool-repo={tool.id}
          className="text-left underline underline-offset-2 hover:text-content"
          onClick={() => void openUrl(lines.repo).catch(() => onTrouble(PROOF_TOOLS_TRY_AGAIN))}
        >
          {lines.repoLabel}
        </button>
      </p>
      <p data-proof-tool-needs>{lines.needs}</p>
      {lines.external ? <p data-proof-tool-external>{lines.external}</p> : null}
      {lines.install ? (
        <>
          <p>
            <code data-proof-tool-install className="select-text break-words font-mono">
              {lines.install.command}
            </code>
          </p>
          <p className="text-content/60">{lines.install.note}</p>
        </>
      ) : null}
    </>
  );
}
