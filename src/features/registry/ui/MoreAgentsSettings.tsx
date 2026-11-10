// WP-134b. More agents, on the providers page, off until the person switches it on.

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  MORE_AGENTS_ENABLED_DEFAULT,
  loadMoreAgentsEnabled,
  saveMoreAgentsEnabled,
  subscribeMoreAgentsEnabled,
} from "../../settings/model/settings";
import {
  addRegistryAgent,
  loadRegistryDocument,
  parseArgLines,
  parseEnvLines,
  removeRegistryAgent,
  requestRegistryChat,
  type LoadedRegistry,
} from "../model/registryList";

export function MoreAgentsSettings({ cwd }: { cwd?: string }) {
  const on = useSyncExternalStore(
    subscribeMoreAgentsEnabled,
    loadMoreAgentsEnabled,
    () => MORE_AGENTS_ENABLED_DEFAULT,
  );
  const [doc, setDoc] = useState<LoadedRegistry>(() => loadRegistryDocument());
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDoc(loadRegistryDocument());
  }, [on]);

  useEffect(() => {
    const reload = () => setDoc(loadRegistryDocument());
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, []);

  function refresh() {
    setDoc(loadRegistryDocument());
  }

  function addAgent() {
    const parsedEnv = parseEnvLines(envText);
    if (!parsedEnv.ok) {
      setError(parsedEnv.reason);
      return;
    }
    const added = addRegistryAgent({
      name,
      command: command.trim(),
      args: parseArgLines(argsText),
      env: parsedEnv.env,
    });
    refresh();
    if (!added.ok) {
      setError(added.reason);
      return;
    }
    setName("");
    setCommand("");
    setArgsText("");
    setEnvText("");
    setError(null);
  }

  return (
    <section id="setting-more-agents" data-setting-id="more-agents" className="pt-8">
      <h2 className="text-[13px] font-semibold text-content">More agents</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-content/45">
        A local command that speaks ACP, listed under the eleven CLIs. Off until you switch it on. It is not one of those CLIs.
      </p>
      <div className="mt-2.5 flex items-center justify-between gap-6 rounded-xl border border-content/10 bg-content/3 px-4 py-3.5">
        <span className="text-[13px] text-content">More agents</span>
        <button
          type="button"
          role="switch"
          aria-label="More agents"
          aria-checked={on}
          onClick={() => saveMoreAgentsEnabled(!on)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            on ? "bg-accent" : "bg-content/20"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${
              on ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
      {on ? (
        <div className="mt-3 rounded-xl border border-content/10 bg-content/3 px-4 py-3.5">
          {doc.readable ? null : (
            <p role="status" className="mb-3 text-[13px] text-content/70">
              The list could not be read. Nothing was changed.
            </p>
          )}
          <div className="grid gap-3">
            <label className="grid gap-1 text-[12px] text-content/60">
              Name
              <input
                aria-label="Agent name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="rounded-md border border-content/10 bg-transparent px-2 py-1.5 text-[13px] text-content"
              />
            </label>
            <label className="grid gap-1 text-[12px] text-content/60">
              Command
              <input
                aria-label="Command"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                className="rounded-md border border-content/10 bg-transparent px-2 py-1.5 text-[13px] text-content"
              />
            </label>
            <label className="grid gap-1 text-[12px] text-content/60">
              Arguments, one per line
              <textarea
                aria-label="Arguments"
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
                rows={3}
                className="rounded-md border border-content/10 bg-transparent px-2 py-1.5 text-[13px] text-content"
              />
            </label>
            <label className="grid gap-1 text-[12px] text-content/60">
              Environment, one name=value per line. Values are not shown again.
              <textarea
                aria-label="Environment"
                value={envText}
                onChange={(event) => setEnvText(event.target.value)}
                rows={2}
                className="rounded-md border border-content/10 bg-transparent px-2 py-1.5 text-[13px] text-content"
              />
            </label>
            <button
              type="button"
              disabled={!doc.readable}
              onClick={addAgent}
              className="w-fit rounded-md border border-content/10 px-2 py-1 text-[13px] text-content disabled:opacity-40"
            >
              Add agent
            </button>
            {error ? (
              <p role="status" className="text-[13px] text-content/70">
                {error}
              </p>
            ) : null}
          </div>
          <ul data-agent-list className="mt-4 grid gap-2">
            {doc.agents.map((agent) => (
              <li key={agent.id} className="flex flex-wrap items-center gap-2 text-[13px] text-content">
                <span className="font-medium">{agent.name}</span>
                <span className="text-content/50">{agent.command}</span>
                <span className="text-content/50">
                  {agent.args.length === 1 ? "1 argument" : `${agent.args.length} arguments`}
                </span>
                <span className="text-content/50">
                  {agent.env.length === 0
                    ? "No extra environment variables."
                    : agent.env.length === 1
                      ? "1 environment variable."
                      : `${agent.env.length} environment variables.`}
                </span>
                <button
                  type="button"
                  aria-label={`Start a chat with ${agent.name}`}
                  onClick={() => requestRegistryChat(agent.id, cwd ? { cwd } : undefined)}
                  className="rounded-md border border-content/10 px-2 py-1"
                >
                  Start a chat
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${agent.name}`}
                  onClick={() => {
                    removeRegistryAgent(agent.id);
                    refresh();
                  }}
                  className="rounded-md border border-content/10 px-2 py-1"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {doc.rejected.map((row) => (
            <p key={`${row.index}-${row.label}`} role="status" className="mt-2 text-[13px] text-content/70">
              {row.label} was skipped. {row.reason}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
