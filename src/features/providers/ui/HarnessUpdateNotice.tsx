import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassBackdrop } from "../../../app/shell/GlassBackdrop";
import {
  isHarnessAvailable,
  probeHarnessAvailability,
} from "../../../integrations/harness/core/availability";
import {
  inspectHarnessBinary,
  updateHarnessCli,
} from "../../../integrations/harness/core/child";
import {
  compareSemver,
  parseOpenCodeVersion,
} from "../../../integrations/harness/providers/opencode/opencodeProtocol";
import { refreshHarnessCatalogs } from "../../../integrations/harness/core/registry";
import { LAYER } from "../../../shared/lib/layers";
import { Check, Loader, X } from "../../../shared/ui/icons";
import { isPickerProviderVisible } from "../../sessions/model/models";
import {
  HARNESS_TITLE,
  HARNESSES,
  type HarnessId,
} from "../../sessions/model/session";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import {
  announceHarnessUpdated,
  claimLaunchHarnessUpdateCheck,
  fetchLatestHarnessVersion,
  findHarnessUpdates,
  onHarnessUpdated,
  UPDATABLE_HARNESSES,
  type HarnessUpdate,
} from "../model/harnessUpdates";

/**
 * Shared by every mount in this window: a StrictMode remount must reuse the
 * first run, since the launch claim it made cannot be taken twice.
 */
let launchCheck: Promise<HarnessUpdate[]> | null = null;

function checkForHarnessUpdates(): Promise<HarnessUpdate[]> {
  launchCheck ??= runLaunchCheck().catch(() => []);
  return launchCheck;
}

async function runLaunchCheck(): Promise<HarnessUpdate[]> {
  if (!(await claimLaunchHarnessUpdateCheck())) return [];
  await probeHarnessAvailability();
  return findHarnessUpdates({
    harnesses: HARNESSES.filter(
      (id) =>
        UPDATABLE_HARNESSES.has(id) &&
        isHarnessAvailable(id) &&
        isPickerProviderVisible(id),
    ),
    installedVersion: async (id) => (await inspectHarnessBinary(id)).version,
    latestVersion: fetchLatestHarnessVersion,
  });
}

type RowState =
  | { status: "idle" }
  | { status: "updating" }
  | { status: "updated"; version: string }
  | { status: "failed"; error: string; installed?: string; latest: string };

/** The card's title in the app's words: the tool by name ("Claude Code update available"), never "Harness". */
export function updateTitle(titles: readonly string[]): string {
  if (titles.length === 1) return `${titles[0]} update available`;
  return `${titles.length} agent updates available`;
}

export function updateFailedMessage(harness: HarnessId): string {
  return `Couldn't update ${HARNESS_TITLE[harness]}. Try again, or open Terminal for details.`;
}

/**
 * Asks the CLI itself, fresh, what it is on now. An update finished in
 * Terminal or another window must clear the card instead of leaving the
 * version read at launch on screen.
 */
export async function stillBehind(
  updates: HarnessUpdate[],
  installedVersion: (id: HarnessId) => Promise<string | undefined> = async (
    id,
  ) => (await inspectHarnessBinary(id)).version,
): Promise<HarnessUpdate[]> {
  const checked = await Promise.all(
    updates.map(async (update) => {
      try {
        const now = parseOpenCodeVersion((await installedVersion(update.harness)) ?? "");
        if (!now) return update;
        if (compareSemver(now, update.latest) >= 0) return null;
        return { ...update, installed: now };
      } catch {
        return update;
      }
    }),
  );
  return checked.filter((u): u is HarnessUpdate => u !== null);
}

/**
 * Some updaters exit cleanly without installing anything, so success is the
 * version the CLI reports afterwards, not the exit code. Its models are
 * reloaded before the row says so, so the picker is current by then.
 */
async function runUpdate(update: HarnessUpdate): Promise<RowState> {
  let version: string | undefined;
  try {
    await updateHarnessCli(update.harness);
  } catch (error) {
    // An updater can exit non-zero after it did install; the version decides.
    void error;
  }
  try {
    const after = await inspectHarnessBinary(update.harness);
    version = parseOpenCodeVersion(after.version ?? "") ?? undefined;
    if (!after.error && version && compareSemver(version, update.latest) >= 0) {
      await refreshHarnessCatalogs([update.harness], { force: true });
      void announceHarnessUpdated(update.harness).catch(() => undefined);
      return { status: "updated", version };
    }
  } catch {
    // Could not read the version: never call that a success.
  }
  return {
    status: "failed",
    error: updateFailedMessage(update.harness),
    installed: version ?? update.installed,
    latest: update.latest,
  };
}

/** Checked once per app launch, in whichever window asks first. */
export function HarnessUpdateNotice({
  topOffset = 12,
  onHeightChange,
  placement = "top-right",
}: {
  topOffset?: number;
  onHeightChange?: (height: number) => void;
  /** "bottom-left" keeps it over the sidebar, off a full-width view such as the hub's Today. It then takes no room
   * from the top-right toast stack. */
  placement?: "top-right" | "bottom-left";
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [updates, setUpdates] = useState<HarnessUpdate[]>([]);
  const [rows, setRows] = useState<Partial<Record<HarnessId, RowState>>>({});

  // Mounted in every window, so the window that ran the update tells the
  // others to pick up the new CLI's models too.
  useEffect(() => {
    const unlisten = onHarnessUpdated((harness) => {
      void refreshHarnessCatalogs([harness], { force: true });
    }).catch(() => undefined);
    return () => {
      void unlisten.then((stop) => stop?.());
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void checkForHarnessUpdates()
      .then((next) => stillBehind(next))
      .then((next) => {
        if (!cancelled) setUpdates(next);
      });
    // Re-check whenever the window comes back, e.g. after updating in Terminal.
    const recheck = () => {
      setUpdates((current) => {
        if (current.length === 0) return current;
        void stillBehind(current).then((next) => {
          if (cancelled) return;
          if (next.length === 0) launchCheck = Promise.resolve([]);
          setUpdates((latest) =>
            latest.filter((u) => next.some((n) => n.harness === u.harness)).map(
              (u) => next.find((n) => n.harness === u.harness) ?? u,
            ),
          );
        });
        return current;
      });
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);

  const visible = updates.length > 0;
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !onHeightChange) return;
    const measure = () => onHeightChange(placement === "top-right" ? panel.offsetHeight : 0);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => {
      observer.disconnect();
      onHeightChange(0);
    };
  }, [visible, onHeightChange, placement]);
  if (!visible) return null;

  const stateOf = (harness: HarnessId): RowState =>
    rows[harness] ?? { status: "idle" };
  const busy = updates.some(
    (update) => stateOf(update.harness).status === "updating",
  );
  const pending = updates.filter((update) => {
    const status = stateOf(update.harness).status;
    return status === "idle" || status === "failed";
  });
  const anyUpdated = updates.some(
    (update) => stateOf(update.harness).status === "updated",
  );

  const start = (targets: HarnessUpdate[]) => {
    for (const update of targets) {
      setRows((current) => ({
        ...current,
        [update.harness]: { status: "updating" },
      }));
      void runUpdate(update).then((result) =>
        setRows((current) => ({ ...current, [update.harness]: result })),
      );
    }
  };
  const dismiss = () => {
    // Only for this run: the next launch checks and offers again.
    launchCheck = Promise.resolve([]);
    setUpdates([]);
  };

  return createPortal(
    <section
      ref={panelRef}
      aria-label="Agent updates"
      role="status"
      data-placement={placement}
      style={placement === "top-right" ? { zIndex: LAYER.toast, top: topOffset } : { zIndex: LAYER.toast, bottom: 36, left: 8 }}
      className={`fixed isolate overflow-hidden rounded-xl border border-content/10 text-content shadow-xl ${
        placement === "top-right" ? "right-3 w-[min(340px,calc(100vw-24px))]" : "w-[244px]"
      }`}
    >
      <GlassBackdrop />
      <div className="relative z-[1]">
        <div className="flex items-center gap-2 border-b border-stroke px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">
            {updateTitle(updates.map((u) => HARNESS_TITLE[u.harness]))}
          </span>
          {pending.length > 1 && !updates.some((u) => stateOf(u.harness).status === "failed") ? (
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[11px] font-medium text-content/70 hover:bg-content/10 hover:text-content"
              onClick={() => start(pending)}
            >
              Update all
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss harness updates"
            disabled={busy}
            className="grid size-6 shrink-0 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content disabled:opacity-40 disabled:hover:bg-transparent"
            onClick={dismiss}
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        </div>
        <div className="divide-y divide-stroke">
          {updates.map((update) => (
            <HarnessUpdateRow
              key={update.harness}
              update={update}
              state={stateOf(update.harness)}
              onUpdate={() => start([update])}
            />
          ))}
        </div>
        <p className="border-t border-stroke px-3 py-2 text-[11px] text-content/50">
          {anyUpdated
            ? "Model picker refreshed with the new version’s models."
            : "New models often need the latest version."}
        </p>
      </div>
    </section>,
    document.body,
  );
}

function HarnessUpdateRow({
  update,
  state,
  onUpdate,
}: {
  update: HarnessUpdate;
  state: RowState;
  onUpdate: () => void;
}) {
  return (
    <article className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <HarnessIcon harness={update.harness} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {HARNESS_TITLE[update.harness]}
        </span>
        {state.status === "updated" ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-400">
            <Check className="size-3.5" />
            Updated to {state.version}
          </span>
        ) : state.status === "failed" ? null : (
          <>
            <span className="shrink-0 font-mono text-[11px] text-content/50">
              {update.installed} → {update.latest}
            </span>
            <button
              type="button"
              disabled={state.status === "updating"}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-content/10 px-2 py-1 text-[11px] font-medium hover:bg-content/15 disabled:opacity-60 disabled:hover:bg-content/10"
              onClick={onUpdate}
            >
              {state.status === "updating" ? (
                <>
                  <Loader className="size-3 animate-spin" />
                  Updating
                </>
              ) : (
                "Update"
              )}
            </button>
          </>
        )}
      </div>
      {state.status === "failed" ? (
        <div role="alert" className="mt-1.5">
          <p className="text-[12px] leading-relaxed text-content/90">
            {state.error}
          </p>
          <p className="mt-1 font-mono text-[10px] text-content/40">
            Installed {state.installed ?? update.installed} · Latest {state.latest}
          </p>
          <button
            type="button"
            className="mt-2 rounded-md bg-content/10 px-2 py-1 text-[11px] font-medium hover:bg-content/15"
            onClick={onUpdate}
          >
            Try again
          </button>
        </div>
      ) : null}
    </article>
  );
}
