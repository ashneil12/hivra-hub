// WP-92: the chat's key ask, as a secret form.
//
// A finished turn that wrote "Needs Ash (provide): <a key>" used to leave the person with the composer, where the key
// would become a chat message and land in blocks_json and the transcript. This card takes the value instead: it lives
// in the input until Save, is read once, and goes straight to `secrets_save_new`. It never enters React state, props,
// localStorage or an error message, and the node (with the field) is removed once it closes.
import { useRef, useState } from "react";

import { keyAskFor, type ChatLike } from "../../hub/model/chatQuestions";
import { projectScope, saveNew, scopeLabel, slugIsValid, slugOf } from "../model/secrets";

const FAILED = "That key wasn't saved. Try again on a fresh card.";
const NAME_RULE = "A key's name is lower-case letters, digits and dashes, 1 to 64 characters.";

type KeyAskChat = ChatLike & { id: string };

/**
 * The secret form for the chat's open key ask; nothing when the chat isn't asking for a key. `project` is the folder of
 * the project the chat works in (what `secrets_run` looks in first); the key is saved for that project unless the person
 * picks everywhere, and the form says which before anything is saved. A chat with no project saves for everywhere.
 */
export function SecretKeyAsk({ chat, project }: { chat?: KeyAskChat | null; project?: string | null }) {
  const asked = chat ? keyAskFor(chat) : null;
  const key = asked && chat ? `${chat.id}\u0000${asked.ask}` : "";
  const [gone, setGone] = useState<string | null>(null);
  if (!asked || gone === key) return null;
  return (
    <KeyAskForm
      key={key}
      ask={asked.ask}
      suggested={asked.name}
      project={project?.trim() || null}
      onClose={() => setGone(key)}
    />
  );
}

function KeyAskForm({
  ask,
  suggested,
  project,
  onClose,
}: {
  ask: string;
  suggested: string;
  project: string | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(suggested);
  // A project chat's key is the project's own by default, which is also where `secrets_run` looks first.
  const [scope, setScope] = useState(project ? projectScope(project) : "global");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = useRef<HTMLInputElement>(null);

  const save = async () => {
    if (busy || !value.current) return;
    if (!slugIsValid(name)) {
      setError(NAME_RULE);
      return;
    }
    const text = value.current.value;
    setBusy(true);
    setError(null);
    try {
      await saveNew(scope, slugOf(name), null, text);
      value.current.value = "";
      setSaved(true);
    } catch {
      // One sentence, never the value and never the store's raw text.
      value.current.value = "";
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="A key is needed" className="rounded-lg border border-content/10 bg-content/[0.03] p-3">
      <p className="text-[12px] text-content/50">This chat needs a key from you</p>
      <p className="mt-1 text-[13px] text-content">{ask}</p>
      {saved ? (
        <div className="mt-3 flex items-center gap-3">
          <p className="text-[12px] text-content/60">Saved for {scopeLabel(scope)}. Saved in your Mac's keychain.</p>
          <button type="button" className="text-[12px] text-content/60 hover:text-content" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <>
          <label className="mt-3 block text-[12px] text-content/60" htmlFor="secret-key-ask-name">
            Name (agents ask by this)
          </label>
          <input
            id="secret-key-ask-name"
            className="mt-1 w-full rounded border border-content/15 bg-transparent px-2 py-1 text-[13px]"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {name && !slugIsValid(name) ? (
            <p role="alert" className="mt-1 text-[12px] text-red-400">
              {NAME_RULE}
            </p>
          ) : (
            <p className="mt-1 text-[12px] text-content/40">Stored as {slugOf(name) || "…"}</p>
          )}
          {project ? (
            <>
              <label className="mt-2 block text-[12px] text-content/60" htmlFor="secret-key-ask-scope">
                Who can use it
              </label>
              <select
                id="secret-key-ask-scope"
                className="mt-1 w-full rounded border border-content/15 bg-transparent px-2 py-1 text-[13px]"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              >
                <option value={projectScope(project)}>{scopeLabel(projectScope(project))}</option>
                <option value="global">{scopeLabel("global")}</option>
              </select>
            </>
          ) : null}
          <p className="mt-2 text-[12px] text-content/60">It will be saved for: {scopeLabel(scope)}</p>
          <label className="mt-2 block text-[12px] text-content/60" htmlFor="secret-key-ask-value">
            The key
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="secret-key-ask-value"
              ref={value}
              type={show ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded border border-content/15 bg-transparent px-2 py-1 text-[13px]"
            />
            <button type="button" className="text-[12px] text-content/60 hover:text-content" onClick={() => setShow((shown) => !shown)}>
              {show ? "Hide" : "Show"}
            </button>
          </div>
          {error ? (
            <p role="alert" className="mt-2 text-[12px] text-red-400">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              disabled={busy}
              className="rounded bg-content/15 px-3 py-1 text-[12px] text-content disabled:opacity-50"
              onClick={() => void save()}
            >
              Save
            </button>
            <button type="button" className="text-[12px] text-content/60 hover:text-content" onClick={onClose}>
              Not now
            </button>
            <span className="text-[11px] text-content/40">Saved in your Mac's keychain once saved</span>
          </div>
        </>
      )}
    </section>
  );
}
