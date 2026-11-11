import { Search } from "../../../shared/ui/icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  loadProjectFiles,
  peekProjectFiles,
  rankProjectFiles,
  recentOpenedFiles,
  rememberOpenedFile,
  type RankedFile,
} from "../model/fileIndex";
import { LAYER } from "../../../shared/lib/layers";
import {
  looksLikeProject,
} from "../../projects/model/recents";
import type { OpenFileFn } from "../../search/model/search";
import {
  finderActiveIndex,
  finderKeyAction,
  type FinderHit,
  type FinderScope,
} from "../../search/model/finder";
import { FinderList } from "../../search/ui/FinderList";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { FileTypeIcon } from "./FileTypeIcon";
import { MatchText } from "../../../shared/ui/MatchText";
import { MOD, SHIFT } from "../../../platform/tauri/platform";
// WP-93: the command palette is every command the app has, not one "reload".
import {
  resolvePaletteRows,
  type PaletteContext,
  type PaletteRow,
} from "../../search/model/commandRegistry";
import {
  commandItems,
  loadPaletteState,
  paletteList,
  recordPalettePick,
  recordPaletteUse,
  savePaletteState,
  stepRunnable,
  type PaletteItem,
} from "../../search/model/paletteRanking";

export function reloadActionHint(mod = MOD, shift = SHIFT) {
  return `${mod}${shift}R`;
}

/** The palette with nothing open: every command, and what could run alone. */
const NOTHING_OPEN: PaletteContext = {
  project: null,
  terminal: false,
  chat: false,
  busy: false,
  terminalFocus: false,
  pickerFocus: false,
  editor: false,
};

/** A keybinding label with the one dash the shortcut table uses for a range. */
function readableShortcut(keys: string): string {
  return keys.includes("…") ? keys.replace("…", " to ") : keys;
}

type FinderPalette = {
  hits: readonly FinderHit[];
  scope: FinderScope;
  onQuery: (query: string) => void;
  onToggleScope: () => void;
  onOpen: (hit: FinderHit, beside: boolean) => void;
};

type Props = {
  open: boolean;
  cwd: string;
  openPaths?: string[];
  initialQuery?: string;
  onOpenFile: OpenFileFn;
  /** The older command hook, by id; the palette prefers onRunCommand. */
  onRunAction?: (id: string) => void;
  onClose: () => void;
  /** WP-74: set when this palette is the finder. Off for go to file. */
  finder?: FinderPalette;
  /** WP-93: what the app can do right now, so a command that cannot run says why. */
  paletteContext?: PaletteContext;
  /** WP-93: runs a command through the handler its shortcut already uses. */
  onRunCommand?: (command: PaletteRow) => void;
};

export function FilePicker({
  open,
  cwd,
  openPaths = [],
  initialQuery = "",
  onOpenFile,
  onRunAction,
  onClose,
  finder,
  paletteContext,
  onRunCommand,
}: Props) {
  const peekFiles = () => peekProjectFiles(cwd);
  const search = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onFinderQuery = useRef(finder?.onQuery);
  onFinderQuery.current = finder?.onQuery;
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const activeHitId = useRef<string | null>(null);
  const finderHitsRef = useRef(finder?.hits);
  finderHitsRef.current = finder?.hits;
  const finderHitKey = finder?.hits.map((hit) => hit.id).join("\0") ?? "";
  const [files, setFiles] = useState(() => peekFiles() ?? []);
  const [loading, setLoading] = useState(() => peekFiles() == null);
  const [error, setError] = useState<string | null>(null);

  const recents = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const path of [...recentOpenedFiles(cwd), ...openPaths]) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  }, [cwd, openPaths, open]);
  const paletteMode = query.trim().startsWith(">");
  const actionQuery = paletteMode ? query.trim().slice(1).trim() : "";

  const results = useMemo(
    () => (paletteMode ? [] : rankProjectFiles(files, query, recents)),
    [files, paletteMode, query, recents],
  );
  // WP-93: the palette reads the app once, when it opens, so the chords and
  // what can run are what was true as the person reached for it.
  const paletteContextRef = useRef(paletteContext);
  paletteContextRef.current = paletteContext;
  const rows = useMemo(
    () =>
      paletteMode
        ? resolvePaletteRows(paletteContextRef.current ?? NOTHING_OPEN)
        : [],
    [paletteMode],
  );
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const [paletteState, setPaletteState] = useState(loadPaletteState);
  const paletteItems = useMemo(
    () =>
      paletteMode
        ? paletteList(
            rows.map((row) => ({
              id: row.id,
              label: row.label,
              group: row.group,
              blockedReason: row.blockedReason,
            })),
            actionQuery,
            paletteState,
            Date.now(),
          )
        : [],
    [paletteMode, rows, actionQuery, paletteState],
  );
  const paletteCommands = useMemo(() => commandItems(paletteItems), [paletteItems]);
  const showingFinder = finder != null && !paletteMode;
  const optionCount = paletteMode
    ? paletteCommands.length
    : showingFinder
      ? finder.hits.length
      : results.length;

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    onFinderQuery.current?.(initialQuery);
    setActive(0);
    activeHitId.current = null;
    setError(null);
    const searchable = looksLikeProject(cwd);
    const cached = peekFiles();
    if (cached) {
      setFiles(cached);
      setLoading(false);
    } else {
      setFiles([]);
      setLoading(searchable);
    }
    if (!searchable) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void loadProjectFiles(cwd, true)
      .then((next) => {
        if (cancelled) return;
        setFiles(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd, initialQuery]);

  useEffect(() => {
    setActive((index) =>
      optionCount === 0 ? 0 : Math.min(index, optionCount - 1),
    );
  }, [optionCount]);

  useEffect(() => {
    const hits = finderHitsRef.current;
    if (!hits) return;
    setActive((index) => finderActiveIndex(hits, activeHitId.current, index));
  }, [finderHitKey]);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  const pick = (file: RankedFile) => {
    rememberOpenedFile(cwd, file.path);
    onOpenFile(file.path, undefined, { exact: true });
    onClose();
  };
  // WP-93: a command runs through the handler its shortcut already uses, and
  // the query remembers the pick so it comes first next time.
  const runCommand = (item: Extract<PaletteItem, { kind: "command" }>) => {
    if (item.blockedReason) return;
    const row = rowsById.get(item.command.id);
    // Another window shares this history, so read it as it is now and add to
    // that, instead of writing back what this palette saw when it opened.
    const at = Date.now();
    const next = recordPalettePick(
      recordPaletteUse(loadPaletteState(), item.command.id, at),
      actionQuery,
      item.command.id,
      at,
    );
    setPaletteState(next);
    savePaletteState(next);
    onClose();
    // Run it once the palette has unmounted and focus has left its input, as
    // the shortcut would: Switch model refuses while focus is in a picker.
    window.setTimeout(() => {
      if (onRunCommand && row) onRunCommand(row);
      else if (onRunAction && row?.binding === "View: Reload") onRunAction("reload");
    }, 0);
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (showingFinder && finder) {
      const action = finderKeyAction({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
      });
      if (action?.type === "move") {
        e.preventDefault();
        if (optionCount === 0) return;
        setActive((index) => {
          const next = (index + action.delta + optionCount) % optionCount;
          activeHitId.current = finder.hits[next]?.id ?? null;
          return next;
        });
        return;
      }
      if (action?.type === "open") {
        e.preventDefault();
        const hit = finder.hits[active];
        if (hit) finder.onOpen(hit, action.beside);
        return;
      }
      if (action?.type === "scope") {
        e.preventDefault();
        finder.onToggleScope();
        return;
      }
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (optionCount === 0) return;
      setActive((index) =>
        paletteMode
          ? Math.max(0, stepRunnable(paletteCommands.map((item) => ({ blockedReason: item.blockedReason })), index, 1))
          : (index + 1) % optionCount,
      );
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (optionCount === 0) return;
      setActive((index) =>
        paletteMode
          ? Math.max(0, stepRunnable(paletteCommands.map((item) => ({ blockedReason: item.blockedReason })), index, -1))
          : (index - 1 + optionCount) % optionCount,
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (paletteMode) {
        const item = paletteCommands[active];
        if (item) runCommand(item);
      } else {
        const file = results[active];
        if (file) pick(file);
      }
      return;
    }
    if (e.key === "Tab") e.preventDefault();
  };

  const empty = showingFinder
    ? finderEmpty(query, finder.hits.length)
    : emptyLabel({
    cwd,
    query,
    loading,
    error,
    fileCount: files.length,
    matchCount: results.length,
    paletteMode,
    actionCount: paletteCommands.length,
  });
  const finderLabel = showingFinder ? "Finder" : paletteMode ? "Command Palette" : "Go to File";

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: LAYER.dialog }}>
      <div className="absolute inset-0" onMouseDown={onClose} />
      <div
        role="dialog"
        aria-label={finderLabel}
        data-file-picker
        {...(finder ? { "data-finder": "" } : {})}
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-[12%] flex w-[min(560px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-content/10 bg-content/5 backdrop-blur-xl"
      >
        <div className="pb-1.5">
          <label className="flex items-center gap-2 border-b border-stroke px-2 py-2.5 text-content/50">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              ref={search}
              type="text"
              value={query}
              placeholder={showingFinder ? "Search Hivra" : "Go to File (type > for commands)"}
              aria-label={finderLabel}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none placeholder:text-content/40"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
                activeHitId.current = null;
                onFinderQuery.current?.(e.target.value);
              }}
              onKeyDown={onSearchKey}
            />
          </label>
        </div>
        {showingFinder && finder ? (
          <p data-finder-scope className="px-3 pb-1 text-[11px] text-content/50">
            {finder.scope === "project" ? "This project" : "All projects"}
          </p>
        ) : null}
        {empty ? (
          <p className="px-3 pb-3 pt-1 text-[12px] text-content/50">{empty}</p>
        ) : paletteMode ? (
          <ActionList
            items={paletteItems}
            active={active}
            query={actionQuery}
            hints={rowsById}
            onActive={setActive}
            onRun={runCommand}
          />
        ) : showingFinder && finder ? (
          <FinderList
            hits={finder.hits}
            active={active}
            onActive={(index) => {
              activeHitId.current = finder.hits[index]?.id ?? null;
              setActive(index);
            }}
            onOpen={finder.onOpen}
          />
        ) : (
          <FileList
            files={results}
            active={active}
            query={query}
            onActive={setActive}
            onPick={pick}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

function finderEmpty(query: string, count: number): string | null {
  if (!query.trim()) return "Type to search";
  if (count === 0) return "Nothing matches";
  return null;
}

function emptyLabel({
  cwd,
  query,
  loading,
  error,
  fileCount,
  matchCount,
  paletteMode,
  actionCount,
}: {
  cwd: string;
  query: string;
  loading: boolean;
  error: string | null;
  fileCount: number;
  matchCount: number;
  paletteMode: boolean;
  actionCount: number;
}): string | null {
  if (paletteMode) return actionCount === 0 ? "No matching commands" : null;
  if (error && fileCount === 0) return error;
  if (!looksLikeProject(cwd)) return "Open a project to search files";
  if (loading && fileCount === 0) return "Indexing files…";
  if (fileCount === 0) return "No files found";
  if (matchCount === 0) {
    return query.trim() ? "No matching files" : "Type a file name to search";
  }
  return null;
}

function ActionList({
  items,
  active,
  query,
  hints,
  onActive,
  onRun,
}: {
  items: PaletteItem[];
  active: number;
  query: string;
  hints: Map<string, PaletteRow>;
  onActive: (index: number) => void;
  onRun: (item: Extract<PaletteItem, { kind: "command" }>) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const activeRef = useRef<HTMLButtonElement>(null);
  let commandIndex = -1;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      ref={lockOverscroll}
      role="listbox"
      aria-label="Commands"
      className="max-h-[min(380px,50vh)] overflow-y-auto overscroll-none px-1.5 pb-1.5"
    >
      {items.map((item) => {
        if (item.kind === "heading") {
          return (
            <p
              key={`heading:${item.label}`}
              data-command-group
              className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-content/40"
            >
              {item.label}
            </p>
          );
        }
        commandIndex += 1;
        const index = commandIndex;
        const highlighted = index === active;
        const row = hints.get(item.command.id);
        const hint = row ? readableShortcut(row.hint ?? "") : "";
        const blocked = item.blockedReason !== null;
        return (
          <button
            key={item.command.id}
            ref={highlighted ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={highlighted}
            aria-disabled={blocked ? "true" : undefined}
            data-command-label={item.command.label}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onActive(index)}
            onClick={() => onRun(item)}
            className={`flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm leading-5 ${
              highlighted ? "bg-selection text-content" : "text-content"
            } ${blocked ? "opacity-45" : ""}`}
          >
            <span className="min-w-0 flex-1 truncate">
              <MatchText
                text={item.command.label}
                positions={item.positions}
                active={Boolean(query)}
              />
              {blocked ? (
                <span className="block text-[11px] leading-4 text-content/70">
                  {item.blockedReason}
                </span>
              ) : null}
            </span>
            {item.command.group && item.command.group !== "App" ? (
              <span className="shrink-0 text-[11px] text-content/35">
                {item.command.group}
              </span>
            ) : null}
            {hint ? (
              <kbd className="ml-auto shrink-0 rounded border border-content/10 bg-content/5 px-1.5 py-0.5 font-mono text-[10px] text-content/50">
                {hint}
              </kbd>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
function FileList({
  files,
  active,
  query,
  onActive,
  onPick,
}: {
  files: RankedFile[];
  active: number;
  query: string;
  onActive: (index: number) => void;
  onPick: (file: RankedFile) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const activeRef = useRef<HTMLButtonElement>(null);
  const pointer = useRef({ x: Number.NaN, y: Number.NaN, allow: false });
  const fromPointer = useRef(false);

  useEffect(() => {
    pointer.current.allow = false;
  }, [files]);

  useEffect(() => {
    if (fromPointer.current) {
      fromPointer.current = false;
      return;
    }
    pointer.current.allow = false;
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onListMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.clientX === pointer.current.x && e.clientY === pointer.current.y) {
      return;
    }
    pointer.current = { x: e.clientX, y: e.clientY, allow: true };
  };

  const onRowEnter = (index: number) => {
    if (!pointer.current.allow) return;
    fromPointer.current = true;
    onActive(index);
  };

  return (
    <div
      ref={lockOverscroll}
      role="listbox"
      aria-label="Files"
      onMouseMove={onListMouseMove}
      className="max-h-[min(380px,50vh)] overflow-y-auto overscroll-none px-1.5 pb-1.5"
    >
      {files.map((file, index) => {
        const highlighted = index === active;
        const slash = file.relative.lastIndexOf("/");
        const dir = slash === -1 ? "" : file.relative.slice(0, slash);
        const nameOffset = slash === -1 ? 0 : slash + 1;
        return (
          <button
            key={file.path}
            ref={highlighted ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={highlighted}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onRowEnter(index)}
            onClick={() => onPick(file)}
            className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm leading-none ${
              highlighted ? "bg-selection text-content" : "text-content"
            }`}
          >
            <span className="shrink-0">
              <FileTypeIcon name={file.name} isDir={false} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              <MatchText
                text={file.name}
                positions={file.positions
                  .filter((pos) => pos >= nameOffset)
                  .map((pos) => pos - nameOffset)}
                active={Boolean(query.trim())}
              />
            </span>
            {dir ? (
              <span className="min-w-0 max-w-[45%] truncate font-mono text-[11px] text-content/40">
                <MatchText
                  text={dir}
                  positions={file.positions.filter((pos) => pos < slash)}
                  active={Boolean(query.trim())}
                />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
