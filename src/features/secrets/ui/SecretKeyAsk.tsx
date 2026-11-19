// WP-92: the chat's key ask, as a secret form.
//
// A finished turn that wrote "Needs Ash (provide): <a key>" used to leave the person with the composer, where the key
// would become a chat message and land in blocks_json and the transcript. This card takes the value instead: it lives
// in the input until Save, is read once, and goes straight to `secrets_save_new`. It never enters React state, props,
// localStorage or an error message, and the node (with the field) is removed once it closes.
import { useRef, useState } from "react";

import { keyAskFor, type ChatLike } from "../../hub/model/chatQuestions";
import { projectScope, saveNew, scopeLabel, slugIsValid, slugOf } from "../model/secrets";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";

/** The ask as part of a sentence: no trailing comma or full stop, no leading capital ("a new Resend key, ..."). */
export function plainAsk(ask: string): string {
  const text = ask.replace(/\s+/g, " ").trim().replace(/[\s,;:.]+$/, "");
  return text || "a key";
}

const FAILED = "That key wasn't saved. Try again on a fresh card.";
const NAME_RULE = "A key's name is lower-case letters, digits and dashes, 1 to 64 characters.";

type KeyAskChat = ChatLike & { id: string };

/**
 * The secret form for the chat's open key ask; nothing when the chat isn't asking for a key. `project` is the folder of
 * the project the chat works in (what `secrets_run` looks in first); the key is saved for that project unless the person
 * picks everywhere, and the form says which before anything is saved. A chat with no project saves for everywhere.
 */
export function SecretKeyAsk({
  chat,
  project,
  asker,
}: {
  chat?: KeyAskChat | null;
  project?: string | null;
  /** Who is asking, by the name Ash knows ("Hivra lead"). */
  asker?: string | null;
}) {
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
      asker={asker?.trim() || null}
      onClose={() => setGone(key)}
    />
  );
}

function KeyAskForm({
  ask,
  suggested,
  project,
  asker,
  onClose,
}: {
  ask: string;
  suggested: string;
  project: string | null;
  asker: string | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(suggested);
  // A project chat's key is the project's own by default, which is also where `secrets_run` looks first.
  const [scope, setScope] = useState(project ? projectScope(project) : "global");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState(false);
  const value = useRef<HTMLInputElement>(null);

  const save = async () => {
    if (busy || !value.current) return;
    if (!slugIsValid(name)) {
      setOptions(true);
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

  // Ash (12 Nov): the old card was "so confusing idk what it is". One line says who asks and what for, one field takes
  // the key, and the vault name and scope wait behind "Options".
  const what = plainAsk(ask);
  const where = scopeLabel(scope);
  return (
    <section aria-label="A key is needed" data-secret-key-ask className="rounded-lg border border-content/10 bg-content/[0.03] px-3 py-2.5">
      {saved ? (
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-[13px] text-content/80">
            Saved in your Mac's keychain. {asker ?? "The agent"} can use it now; it never shows in the chat.
          </p>
          <SecondaryButton onClick={onClose}>Done</SecondaryButton>
        </div>
      ) : (
        <>
          <p className="text-[13px] text-content">
            <span className="font-medium">{asker ?? "This chat"}</span> needs {what} to carry on.
          </p>
          <p className="mt-0.5 text-[12px] text-content/50">
            Paste it here, not in the chat. It goes into your Mac's keychain and the agent uses it without seeing it.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input
              id="secret-key-ask-value"
              ref={value}
              type={show ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the key"
              aria-label="The key"
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-content/15 bg-transparent px-2 text-[13px] outline-none focus:border-accent/60"
            />
            <button type="button" className="text-[12px] text-content/50 hover:text-content" onClick={() => setShow((shown) => !shown)}>
              {show ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40"
              onClick={() => void save()}
            >
              Save
            </button>
            <SecondaryButton onClick={onClose}>Not now</SecondaryButton>
          </div>
          {error ? (
            <p role="alert" className="mt-2 text-[12px] text-red-400">
              {error}
            </p>
          ) : null}
          <div className="mt-1.5 flex items-center gap-2 text-[12px] text-content/45">
            <span>
              Saved as “{slugOf(name) || "…"}” for {where}.
            </span>
            <button type="button" className="hover:text-content" aria-expanded={options} onClick={() => setOptions((open) => !open)}>
              {options ? "Hide options" : "Options"}
            </button>
          </div>
          {options ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="text-[12px] text-content/60" htmlFor="secret-key-ask-name">
                Name agents ask for
              </label>
              <input
                id="secret-key-ask-name"
                className="h-7 w-56 rounded-md border border-content/15 bg-transparent px-2 text-[13px] outline-none focus:border-accent/60"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              {project ? (
                <select
                  id="secret-key-ask-scope"
                  aria-label="Who can use it"
                  className="h-7 rounded-md border border-content/15 bg-transparent px-2 text-[13px]"
                  value={scope}
                  onChange={(event) => setScope(event.target.value)}
                >
                  <option value={projectScope(project)}>{scopeLabel(projectScope(project))}</option>
                  <option value="global">{scopeLabel("global")}</option>
                </select>
              ) : null}
              {name && !slugIsValid(name) ? (
                <p role="alert" className="w-full text-[12px] text-red-400">
                  {NAME_RULE}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
