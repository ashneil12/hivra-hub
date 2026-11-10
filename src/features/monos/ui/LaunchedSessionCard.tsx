import type { ReactNode } from "react";
import { projectName } from "../../../shared/lib/paths";
import { cliLabel } from "../../crew/model/clis";
import { resolveModel } from "../../sessions/model/models";
import {
  Chatting,
  CheckCircle,
  CircleAlert,
  CircleDashed,
  CircleX,
  Clock,
  Loader,
} from "../../../shared/ui/icons";
import {
  sessionDisplayTitle,
  type MonoSpawnedSession,
} from "../../sessions/model/session";
import { ModelInUseIcon } from "../../sessions/ui/HarnessIcon";
import type {
  LaunchedSessionState,
  LaunchedSessionView,
} from "../model/monoSpawnedSessions";

/** The worker's model, named as the composer names it ("Sonnet 5"). */
function modelLabel(harness: MonoSpawnedSession["harness"], model: string): string {
  const name = resolveModel(harness, model).name;
  return harness === "claude" ? name.replace(/^Claude /, "") : name;
}

const STATUS: Record<LaunchedSessionState, { label: string; icon: ReactNode }> =
  {
    working: {
      label: "Working",
      icon: (
        <Loader
          className="size-4 shrink-0 animate-spin text-content/55 motion-reduce:animate-none"
          strokeWidth={1.75}
        />
      ),
    },
    input: {
      label: "Needs you",
      icon: (
        <Clock className="size-4 shrink-0 text-content/55" strokeWidth={1.75} />
      ),
    },
    draft: {
      label: "Draft",
      icon: (
        <CircleDashed
          className="size-4 shrink-0 text-content/45"
          strokeWidth={1.75}
        />
      ),
    },
    failed: {
      label: "Failed",
      icon: (
        <CircleAlert
          className="size-4 shrink-0 text-red-400"
          strokeWidth={1.75}
        />
      ),
    },
    stopped: {
      label: "Stopped",
      icon: (
        <CircleX
          className="size-4 shrink-0 text-content/45"
          strokeWidth={1.75}
        />
      ),
    },
    waiting: {
      label: "Waiting for a free worker",
      icon: (
        <Clock
          className="size-4 shrink-0 text-content/45"
          strokeWidth={1.75}
        />
      ),
    },
    done: {
      label: "Done",
      icon: (
        <CheckCircle
          className="size-4 shrink-0 text-emerald-400/90"
          strokeWidth={1.75}
        />
      ),
    },
  };

/** The stalled circle (the Sessions panel's SubChatList uses the same mark). The spinner is only for running work. */
const STALLED = {
  label: "Stalled",
  icon: <CircleAlert data-launched-stalled className="size-4 shrink-0 text-content/60" strokeWidth={1.75} />,
};

/**
 * A session the Mono started, as a line under its reply like an artifact:
 * a spinner while it works, a check once it is done, and the project it runs
 * in. Without `view` (a window that does not track sessions) it shows no
 * status. It takes the replies' reading width (about 640px, the 1:1's 75ch),
 * not a narrow pill; the title fills it and the project sits at its end.
 */
export function LaunchedSessionCard({
  launch,
  view,
  open = false,
  stalled = false,
  onOpen,
}: {
  launch: MonoSpawnedSession;
  view?: LaunchedSessionView;
  /** r97 (Critiquito a): its row stalled while its chat still reads as working: the stalled circle, never a spinner. */
  stalled?: boolean;
  /** Shown in the sidebar right now. */
  open?: boolean;
  onOpen?: () => void;
}) {
  const title = sessionDisplayTitle(
    view?.title ?? launch.title,
    launch.harness,
  );
  // WP-171: a task held for another task is not waiting on a free worker. The label and the accessible name agree.
  const status = stalled
    ? STALLED
    : view?.state === "waiting"
      ? { ...STATUS.waiting, label: view.forTask ? "Waiting for another task" : STATUS.waiting.label }
      : view
        ? STATUS[view.state]
        : undefined;
  const ran = modelLabel(launch.harness, launch.model);
  const ranLine = `Runs on ${ran}${launch.effort ? `, ${launch.effort} effort` : ""}`;
  // WP-89: the card names the CLI, the model, the effort and where they came from. No source, no extra line.
  const ranWhere = launch.from
    ? `Runs on ${cliLabel(launch.harness)}, ${ran}${launch.effort ? `, ${launch.effort} effort` : ""} (${launch.from})`
    : undefined;
  // WP-89: the CLI this Mono asked for isn't installed here, so the card says which one and what it runs on instead.
  const fellBack = launch.cliFallback;
  return (
    <button
      type="button"
      data-launched-session={launch.sessionId}
      data-state={stalled ? "stalled" : view?.state}
      aria-label={`Open session ${title}${status ? `, ${status.label.toLowerCase()}` : ""}`}
      aria-pressed={open}
      title={[status?.label, ranLine, launch.from, launch.cliFallback].filter(Boolean).join(" · ")}
      onClick={onOpen}
      disabled={!onOpen}
      className={`@container/card flex min-w-0 max-w-[40rem] flex-1 basis-full items-center gap-2.5 overflow-hidden rounded-xl border py-1.5 pr-1.5 pl-3 text-left font-sans transition-colors hover:border-content/20 hover:bg-content/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60 ${open ? "border-content/20 bg-content/5" : "border-content/10"}`}
    >
      {status?.icon ?? (
        <Chatting
          className="size-4 shrink-0 text-content/45"
          strokeWidth={1.75}
        />
      )}
      {/* r95 (PM): the job's name in full, never cut off: a long one wraps onto a second line. */}
      <span data-launched-title className="min-w-0 flex-1 whitespace-normal break-words text-[13px] leading-snug text-content">
        {title}
        {ranWhere ? (
          <span data-launched-ran className="mt-0.5 block text-[12px] leading-snug text-content/55">
            {ranWhere}
          </span>
        ) : null}
        {fellBack ? (
          <span data-launched-fallback className="mt-0.5 block text-[12px] leading-snug text-amber-500">
            {fellBack}
          </span>
        ) : null}
      </span>
      {view?.state === "waiting" ? (
        <span
          data-launched-waiting
          className="shrink-0 text-[12px] text-content/55"
        >
          {status?.label}
        </span>
      ) : null}
      {/* r95 (PM, worker card a): no engine chip on the card. The title has the room, and which model ran (E7) is in
          the card's tooltip. */}
      {/* Squeezed, the title gives way first and the project after it. r93 (s15 3cde): the chip shrinks to its icon
          inside a whole pill instead of running off the card's clipped edge. r94 (s15 SCRIPTED 8c60): live, a narrow
          card (beside Stalled and Stop) still cut the pill in half, and on the Grok bridge the icon is blank, so it read
          as an empty pill. Below 14rem the card has no room for it, so the chip is not drawn at all. */}
      <span
        data-launched-project
        className="hidden @[14rem]/card:flex min-w-[2.125rem] max-w-[45%] shrink overflow-hidden items-center gap-1 rounded-full border border-content/10 bg-content/5 px-2 py-0.5 text-[12px] text-content/65"
        title={launch.cwd}
      >
        <ModelInUseIcon harness={launch.harness} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{projectName(launch.cwd)}</span>
      </span>
    </button>
  );
}
