import { useEffect, useRef, useState } from "react";
import {
  accessLabel,
  appApi,
  lastUsedLabel,
  type ConsentResult,
  type DoorStatus,
  type GrantView,
  type OutsideApi,
  type PendingPage,
} from "../model/connected";

const BTN =
  "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";

type Props = {
  /** The browser test injects this. The app uses the real commands. */
  api?: OutsideApi;
};

function problemText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "That didn't work.";
}

/** Settings → Connected apps. A late reply never overwrites a newer one. */
export function ConnectedApps({ api = appApi }: Props) {
  const [status, setStatus] = useState<DoorStatus>({ enabled: false, url: null });
  const [grants, setGrants] = useState<GrantView[]>([]);
  const [pending, setPending] = useState<PendingPage>({ requests: [], projects: [] });
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [needProject, setNeedProject] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const generation = useRef(0);

  async function load(gen: number): Promise<boolean> {
    try {
      const [nextStatus, nextGrants, nextPending] = await Promise.all([
        api.status(),
        api.grants(),
        api.pending(),
      ]);
      if (gen !== generation.current) return false;
      setStatus(nextStatus);
      setGrants(nextGrants);
      setPending(nextPending);
      setProblem(null);
      setSent(false);
      return true;
    } catch (error) {
      if (gen !== generation.current) return false;
      setProblem(problemText(error));
      return false;
    }
  }

  useEffect(() => {
    const gen = ++generation.current;
    void load(gen);
    // The injected api is the page's fixture. Reloading when it changes is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function reloadAfter(gen: number, work: () => Promise<unknown>) {
    try {
      await work();
      await load(gen);
    } catch (error) {
      if (gen !== generation.current) return;
      setProblem(problemText(error));
    }
  }

  // The redirect holds the code. Say it was handed to the browser, and never show it.
  async function finishInBrowser(gen: number, work: () => Promise<ConsentResult>) {
    try {
      const result = await work();
      const loaded = await load(gen);
      if (!loaded || gen !== generation.current) return;
      const uri = typeof result.redirectUri === "string" ? result.redirectUri.trim() : "";
      if (uri === "") {
        setProblem("The browser was not sent on.");
        return;
      }
      setSent(true);
    } catch (error) {
      if (gen !== generation.current) return;
      setProblem(problemText(error));
    }
  }

  function choose(requestId: string, projectId: string) {
    setNeedProject(null);
    setPicked((current) => {
      const have = current[requestId] ?? [];
      const next = have.includes(projectId)
        ? have.filter((id) => id !== projectId)
        : [...have, projectId];
      return { ...current, [requestId]: next };
    });
  }

  return (
    <div className="flex flex-col gap-6 text-[13px] text-content/85">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={status.enabled}
          onChange={(event) => {
            const enabled = event.target.checked;
            const gen = ++generation.current;
            void reloadAfter(gen, () => api.setEnabled(enabled));
          }}
        />
        Let AI tools on this computer read Hivra
      </label>
      {status.enabled && status.url && !status.problem ? (
        <p className="text-content/60">{status.url}</p>
      ) : null}
      {status.problem ? <p>{status.problem}</p> : null}
      {status.portTaken ? (
        <button
          type="button"
          className={BTN}
          onClick={() => {
            const gen = ++generation.current;
            void reloadAfter(gen, () => api.pickNewPort());
          }}
        >
          Pick a new port
        </button>
      ) : null}
      {sent ? <p>Finish in the browser window.</p> : null}
      {problem ? (
        <p role="alert" className="text-content/70">
          {problem}
        </p>
      ) : null}

      {pending.requests.map((request) => (
        <section key={request.id} className="flex flex-col gap-2">
          <p>{request.clientName} wants to read Hivra.</p>
          {pending.projects.map((project) => (
            <label key={project.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={(picked[request.id] ?? []).includes(project.id)}
                onChange={() => choose(request.id, project.id)}
              />
              {project.name}
            </label>
          ))}
          {needProject === request.id ? <p>Pick a project first.</p> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={BTN}
              onClick={() => {
                const projectIds = picked[request.id] ?? [];
                if (projectIds.length === 0) {
                  setNeedProject(request.id);
                  return;
                }
                const gen = ++generation.current;
                void finishInBrowser(gen, () => api.approve(request.id, projectIds, false));
              }}
            >
              Allow read access
            </button>
            <button
              type="button"
              className={BTN}
              onClick={() => {
                const projectIds = picked[request.id] ?? [];
                if (projectIds.length === 0) {
                  setNeedProject(request.id);
                  return;
                }
                const gen = ++generation.current;
                void finishInBrowser(gen, () => api.approve(request.id, projectIds, true));
              }}
            >
              Allow read and task writes
            </button>
            <button
              type="button"
              className={BTN}
              onClick={() => {
                const gen = ++generation.current;
                void finishInBrowser(gen, () => api.deny(request.id));
              }}
            >
              Don't allow
            </button>
          </div>
        </section>
      ))}

      {grants.length === 0 ? <p>Nothing is connected.</p> : null}
      <ul className="flex flex-col gap-3">
        {grants.map((grant) => (
          <li key={grant.id} className="flex flex-wrap items-center gap-3">
            <span>{grant.clientName}</span>
            <span>{accessLabel(grant.write)}</span>
            <span>{grant.projects.join(", ")}</span>
            <span>{lastUsedLabel(grant.lastUsedAt)}</span>
            <button
              type="button"
              className={BTN}
              onClick={() => {
                const gen = ++generation.current;
                void reloadAfter(gen, () => api.disconnect(grant.id));
              }}
            >
              Disconnect
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
