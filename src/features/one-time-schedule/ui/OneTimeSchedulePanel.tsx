import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { projectKey } from "../../../shared/lib/paths";
import { LAYER } from "../../../shared/lib/layers";
import {
  CLOSED_APP_WARNING,
  instantFromLocalInput,
  oneTimeStatusLabel,
  scheduleWhenLabel,
  type OneTimeSchedule,
  type OneTimeScheduleStore,
  type OneTimeTarget,
} from "../model/oneTimeSchedule";

export type OneTimeChatChoice = { id: string; title: string };
export type OneTimeProjectChoice = { id: string; label: string };

const FIELD = "block text-[12px] text-content/70";
const CONTROL =
  "mt-1 h-7 w-full rounded-md border border-stroke bg-transparent px-2 text-[12px] text-content outline-none";

/** A daily app warns that a closed app misses the run. A dev copy never runs it. */
export function oneTimeConfirmWarning(runsHere: boolean): string {
  return runsHere ? CLOSED_APP_WARNING : "This copy does not run one-time schedules.";
}

export function oneTimeProjectChoices(
  projects: OneTimeProjectChoice[],
): OneTimeProjectChoice[] {
  const seen = new Set<string>();
  const choices: OneTimeProjectChoice[] = [];
  for (const project of projects) {
    if (!project.id || !project.label) continue;
    const key = projectKey(project.id);
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push(project);
  }
  return choices;
}

function preview(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

export function OneTimeSchedulePanel({
  chats,
  projects,
  store,
  runsHere = true,
}: {
  chats: OneTimeChatChoice[];
  projects: OneTimeProjectChoice[];
  store: OneTimeScheduleStore;
  /** False on a dev copy, which never fires a schedule. */
  runsHere?: boolean;
}) {
  const projectChoices = useMemo(() => oneTimeProjectChoices(projects), [projects]);
  const [rows, setRows] = useState<OneTimeSchedule[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<"chat" | "project">(chats.length > 0 ? "chat" : "project");
  const [chatId, setChatId] = useState(chats[0]?.id ?? "");
  const [projectId, setProjectId] = useState(projectChoices[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [localText, setLocalText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ target: OneTimeTarget; prompt: string; localText: string } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!chatId && chats[0]) setChatId(chats[0].id);
  }, [chatId, chats]);
  useEffect(() => {
    if (!projectId && projectChoices[0]) setProjectId(projectChoices[0].id);
  }, [projectId, projectChoices]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void store
        .list()
        .then((next) => {
          if (alive) {
            setRows(next);
            setLoadError(null);
          }
        })
        .catch(() => {
          if (alive) setLoadError("The schedules could not be loaded.");
        });
    };
    refresh();
    const stop = store.subscribe(refresh);
    return () => {
      alive = false;
      stop();
    };
  }, [store]);

  const openConfirm = (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text) {
      setFormError("Write a prompt first.");
      return;
    }
    const runAt = instantFromLocalInput(localText);
    if (runAt == null) {
      setFormError("That time is not a real date.");
      return;
    }
    if (!(runAt > Date.now())) {
      setFormError("Choose a time in the future.");
      return;
    }
    const target: OneTimeTarget | null =
      kind === "chat"
        ? chats.some((chat) => chat.id === chatId)
          ? { kind: "chat", sessionId: chatId }
          : null
        : projectChoices.some((project) => project.id === projectId)
          ? { kind: "project", projectId }
          : null;
    if (!target) {
      setFormError("Choose a chat or a project.");
      return;
    }
    setFormError(null);
    setPending({ target, prompt: text, localText });
  };

  const confirm = async () => {
    if (!pending || saving) return;
    setSaving(true);
    try {
      await store.create(
        { id: crypto.randomUUID(), target: pending.target, prompt: pending.prompt, localText: pending.localText },
        Date.now(),
      );
      setPending(null);
      setPrompt("");
      setLocalText("");
      setFormError(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "That schedule could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await store.cancel(id, Date.now());
      setFormError(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "That schedule could not be cancelled.");
    }
  };

  return (
    <section data-one-time-schedule className="px-2 py-2 text-content">
      <details>
        <summary className="cursor-pointer text-[12px] text-content/80">Run once</summary>
        <p className="mt-1 text-[11px] leading-4 text-content/55">
          One prompt, at a date and time you choose.
        </p>
        {chats.length === 0 && projectChoices.length === 0 ? (
          <p className="mt-2 text-[12px] text-content/60">Open a chat or a project first.</p>
        ) : (
          <form onSubmit={openConfirm} className="mt-2 space-y-2">
            <fieldset className={FIELD}>
              <legend>Where it runs</legend>
              <label className="mt-1 flex items-center gap-1.5">
                <input
                  type="radio"
                  name="one-time-where"
                  checked={kind === "chat"}
                  disabled={chats.length === 0}
                  onChange={() => setKind("chat")}
                />
                Chat
              </label>
              {kind === "chat" ? (
                <select
                  aria-label="Chat"
                  className={CONTROL}
                  value={chatId}
                  onChange={(event) => setChatId(event.target.value)}
                >
                  {chats.map((chat) => (
                    <option key={chat.id} value={chat.id}>
                      {chat.title || "Chat"}
                    </option>
                  ))}
                </select>
              ) : null}
              <label className="mt-1 flex items-center gap-1.5">
                <input
                  type="radio"
                  name="one-time-where"
                  checked={kind === "project"}
                  disabled={projectChoices.length === 0}
                  onChange={() => setKind("project")}
                />
                New chat in a project
              </label>
              {kind === "project" ? (
                <select
                  aria-label="Project"
                  className={CONTROL}
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {projectChoices.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.label}
                    </option>
                  ))}
                </select>
              ) : null}
            </fieldset>
            <label className={FIELD}>
              Prompt
              <textarea
                aria-label="Prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={3}
                className={`${CONTROL} h-auto py-1`}
              />
            </label>
            <label className={FIELD}>
              When
              <input
                aria-label="When"
                type="datetime-local"
                value={localText}
                onChange={(event) => setLocalText(event.target.value)}
                className={CONTROL}
              />
            </label>
            {formError ? <p className="text-[12px] text-content/70">{formError}</p> : null}
            <button
              type="submit"
              className="h-7 rounded-md bg-content px-3 text-[12px] font-medium text-background-base"
            >
              Schedule
            </button>
          </form>
        )}
      </details>
      {pending ? (
        <div
          role="dialog"
          aria-label="Schedule this prompt"
          className="mt-2 rounded-md border border-stroke p-2"
        >
          <p className="text-[12px]">Schedule this prompt?</p>
          <p className="mt-1 text-[12px] leading-4 text-content/80">{oneTimeConfirmWarning(runsHere)}</p>
          <p className="mt-1 text-[12px] text-content/60">{pending.localText.replace("T", " ")}</p>
          <p className="mt-1 text-[12px] text-content/70">{preview(pending.prompt)}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void confirm()}
              className="h-7 rounded-md bg-content px-3 text-[12px] font-medium text-background-base disabled:opacity-40"
            >
              Schedule
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="h-7 rounded-md px-2 text-[12px] text-content/70"
            >
              Not now
            </button>
          </div>
        </div>
      ) : null}
      {loadError ? <p className="mt-2 text-[12px] text-content/70">{loadError}</p> : null}
      {rows.length > 0 ? (
        <ul data-one-time-list className="mt-2 max-h-40 space-y-1 overflow-y-auto">
          {rows.map((row) => (
            <li key={row.id} className="rounded-md border border-stroke px-2 py-1.5">
              <p className="truncate text-[12px]">{preview(row.prompt)}</p>
              <p className="text-[11px] text-content/55">
                {oneTimeStatusLabel(row.status)}
                {` · ${scheduleWhenLabel(row)}`}
              </p>
              {row.status === "scheduled" ? (
                <button
                  type="button"
                  onClick={() => void cancel(row.id)}
                  className="mt-1 text-[12px] text-content/70 underline"
                >
                  Cancel
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function MissedScheduleNotice({
  notices,
  onDone,
  top = 48,
}: {
  notices: { id: string; text: string }[];
  onDone: (id: string) => void;
  /** Pixels from the top of the window, under the notices already there. */
  top?: number;
}) {
  if (notices.length === 0 || typeof document === "undefined") return null;
  return createPortal(
    <section
      aria-label="Missed schedules"
      className="pointer-events-auto fixed right-3 w-[min(320px,calc(100vw-24px))] px-3 py-2 text-content"
      style={{ top, zIndex: LAYER.toast }}
    >
      {notices.map((notice) => (
        <div key={notice.id} className="mb-2 max-w-md rounded-md border border-stroke bg-background-base p-3">
          <p className="text-[13px] leading-5">{notice.text}</p>
          <button
            type="button"
            onClick={() => onDone(notice.id)}
            className="mt-2 h-7 rounded-md bg-content px-3 text-[12px] font-medium text-background-base"
          >
            OK
          </button>
        </div>
      ))}
    </section>,
    document.body,
  );
}
