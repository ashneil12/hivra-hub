// WP-134b. More agents, on the providers page, off until the person switches it on.
// The list is the app's own (src-tauri/src/more_agents.rs). Adding an entry never runs it: the person allows it
// separately, and a chat runs only an allowed entry, read again by the app when the chat starts.

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  MORE_AGENTS_ENABLED_DEFAULT,
  loadMoreAgentsEnabled,
  saveMoreAgentsEnabled,
  subscribeMoreAgentsEnabled,
} from "../../settings/model/settings";
import {
  addMoreAgent,
  approveMoreAgent,
  loadMoreAgents,
  MoreAgentsChangedError,
  newMoreAgentEntry,
  removeMoreAgent,
  subscribeMoreAgents,
  suggestMoreAgentId,
  type MoreAgentsList,
} from "../../providers/model/moreAgents";
import { REGISTRY_CHAT_REFUSED_EVENT, refreshRegistry, requestRegistryChat } from "../model/registryList";

const UNREADABLE = "The list could not be read. Nothing was changed.";

export function MoreAgentsSettings({ cwd }: { cwd?: string }) {
  const on = useSyncExternalStore(
    subscribeMoreAgentsEnabled,
    loadMoreAgentsEnabled,
    () => MORE_AGENTS_ENABLED_DEFAULT,
  );
  const [list, setList] = useState<MoreAgentsList | null>(null);
  const [readable, setReadable] = useState(true);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setList(await loadMoreAgents());
      setReadable(true);
    } catch {
      setReadable(false);
    }
  }

  useEffect(() => {
    const onRefused = (event: Event) => {
      const sentence = (event as CustomEvent<{ sentence?: unknown }>).detail?.sentence;
      if (typeof sentence === "string") setError(sentence);
    };
    window.addEventListener(REGISTRY_CHAT_REFUSED_EVENT, onRefused);
    return () => window.removeEventListener(REGISTRY_CHAT_REFUSED_EVENT, onRefused);
  }, []);

  useEffect(() => {
    if (!on) return;
    void reload();
    void refreshRegistry();
    return subscribeMoreAgents(() => void reload());
  }, [on]);

  async function addAgent() {
    if (!list) return;
    const checked = newMoreAgentEntry({
      id: suggestMoreAgentId(name),
      name: name.trim(),
      command: command.trim(),
      argsText,
    });
    if (!checked.ok) {
      setError(checked.reason);
      return;
    }
    try {
      setList(await addMoreAgent(list, checked.entry));
      setName("");
      setCommand("");
      setArgsText("");
      setError(null);
    } catch (failure) {
      setError(failure instanceof MoreAgentsChangedError ? failure.message : (failure as Error).message);
      void reload();
    }
  }

  async function toggleApproval(id: string, allowed: boolean) {
    try {
      // The allow carries the fingerprint this row shows; the app refuses if the entry changed since.
      const shown = list?.fingerprints[id];
      setList(await approveMoreAgent(id, allowed, allowed ? shown : undefined));
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
      void reload();
    }
  }

  async function removeAgent(index: number) {
    if (!list) return;
    try {
      setList(await removeMoreAgent(list, index));
    } catch (failure) {
      setError((failure as Error).message);
      void reload();
    }
  }

  const canEdit = readable && list !== null;

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
          {readable ? null : (
            <p role="status" className="mb-3 text-[13px] text-content/70">
              {UNREADABLE}
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
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => void addAgent()}
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
            {(list?.rows ?? []).map((row, index) => {
              if (!row.usable) return null;
              const { entry } = row;
              const approved = list?.approved.includes(entry.id) ?? false;
              return (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 text-[13px] text-content">
                  <span className="font-medium">{entry.name}</span>
                  <span className="text-content/50">{entry.command}</span>
                  <span className="text-content/50">
                    {entry.args.length === 1 ? "1 argument" : `${entry.args.length} arguments`}
                  </span>
                  <span className="w-full break-all font-mono text-[12px] text-content/60" data-agent-exact>
                    {[entry.command, ...entry.args].join(" ")}
                  </span>
                  {list?.notes[entry.id] ? (
                    <span className="w-full text-[12px] text-content/70" data-agent-note>
                      {list.notes[entry.id]}
                    </span>
                  ) : null}
                  <span className="w-full break-all font-mono text-[12px] text-content/60" data-agent-resolved>
                    {list?.resolved[entry.id] ?? "Not found on this Mac. Check the command before you allow it."}
                  </span>
                  <span className="text-content/50">{approved ? "Allowed to run." : "Not allowed to run yet."}</span>
                  <button
                    type="button"
                    aria-label={`${approved ? "Withdraw" : "Allow"} ${entry.name}`}
                    onClick={() => void toggleApproval(entry.id, !approved)}
                    className="rounded-md border border-content/10 px-2 py-1"
                  >
                    {approved ? "Withdraw" : "Allow"}
                  </button>
                  <button
                    type="button"
                    aria-label={`Start a chat with ${entry.name}`}
                    onClick={() => requestRegistryChat(entry.id, cwd ? { cwd } : undefined)}
                    className="rounded-md border border-content/10 px-2 py-1"
                  >
                    Start a chat
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${entry.name}`}
                    onClick={() => void removeAgent(index)}
                    className="rounded-md border border-content/10 px-2 py-1"
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
          {(list?.rows ?? []).map((row, index) =>
            row.usable ? null : (
              <p key={`${index}-${row.usable ? "" : (row.name ?? row.id ?? "")}`} role="status" className="mt-2 text-[13px] text-content/70">
                {row.name ?? row.id ?? `Entry ${index + 1}`} was skipped. {row.reason}
              </p>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}
