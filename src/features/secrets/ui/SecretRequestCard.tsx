// WP-92: the secret form card. A form card in the chat (and in the Inbox under Needs, from the same row).
//
// The value lives in the DOM input until Save, is read once, and is passed straight to `secrets_save`. It is never put
// in React state, props, context, localStorage, sessionStorage, IndexedDB or an error message. The card's node is
// removed when it closes, and a failed save clears the field.
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { beginSave, declineRequest, listRequests, saveRequest, slugOf, type RequestRow } from "../model/secrets";

export const SECRETS_CHANGED = "hivra:secrets-changed";

const SAVED = "Saved in your Mac's keychain";
const FAILED = "That key wasn't saved. Try again on a fresh card.";

export function SecretRequestCard({
  request,
  onDone,
}: {
  request: RequestRow;
  onDone: () => void;
}) {
  const [label, setLabel] = useState(request.name);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const token = useRef<string | null>(null);

  // Take the open -> saving transition when the card opens: two windows can't both save the same request.
  useEffect(() => {
    let live = true;
    beginSave(request.id)
      .then((ticket) => {
        if (live) token.current = ticket.token;
      })
      .catch(() => {
        if (live) setError("That card is no longer open.");
      });
    return () => {
      live = false;
      // The field and its value go with the node.
      if (input.current) input.current.value = "";
    };
  }, [request.id]);

  const save = async () => {
    if (busy || !input.current) return;
    const value = input.current.value;
    if (!token.current) {
      setError("That card is still opening. Try again in a moment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveRequest(request.id, token.current, label.trim() || null, value);
      input.current.value = "";
      onDone();
    } catch {
      // One sentence, never the value and never the store's raw text.
      input.current.value = "";
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  };

  const notNow = async () => {
    try {
      await declineRequest(request.id, token.current);
    } finally {
      onDone();
    }
  };

  return (
    <section
      aria-label="A key is needed"
      className="rounded-lg border border-content/10 bg-content/[0.03] p-3"
    >
      <p className="text-[12px] text-content/50">{request.mono ?? "This chat"} needs a key</p>
      <p className="mt-1 text-[13px] text-content">{request.why}</p>
      <p className="mt-2 text-[12px] text-content/60">
        {request.name} · {slugOf(request.name)} · {request.scope === "global" ? "Every project" : request.scope}
      </p>
      <label className="mt-3 block text-[12px] text-content/60" htmlFor={`secret-label-${request.id}`}>
        Label
      </label>
      <input
        id={`secret-label-${request.id}`}
        className="mt-1 w-full rounded border border-content/15 bg-transparent px-2 py-1 text-[13px]"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
      />
      <label className="mt-2 block text-[12px] text-content/60" htmlFor={`secret-value-${request.id}`}>
        The key
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={`secret-value-${request.id}`}
          ref={input}
          type={show ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded border border-content/15 bg-transparent px-2 py-1 text-[13px]"
        />
        <button
          type="button"
          className="text-[12px] text-content/60 hover:text-content"
          onClick={() => setShow((shown) => !shown)}
        >
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
        <button type="button" className="text-[12px] text-content/60 hover:text-content" onClick={() => void notNow()}>
          Not now
        </button>
        <span className="text-[11px] text-content/40">{SAVED} once saved</span>
      </div>
    </section>
  );
}

/** Every pending request, as cards. Mounted once; refreshed when Rust says something changed. */
export function SecretCards({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<RequestRow[]>([]);

  const load = () => {
    listRequests()
      .then(setRows)
      .catch(() => setRows([]));
  };

  useEffect(() => {
    load();
    const un = listen(SECRETS_CHANGED, load);
    return () => {
      void un.then((off) => off());
    };
  }, []);

  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((request) => (
        <SecretRequestCard
          key={request.id}
          request={request}
          onDone={() => {
            load();
            onChanged?.();
          }}
        />
      ))}
    </div>
  );
}