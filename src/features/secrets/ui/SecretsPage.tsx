// WP-92: Settings > Secrets. Every key an agent can use, in the person's keychain.
//
// The page moves handles. Reveal is the one tap that brings a value back, and its field is cleared when the row closes.
// Nothing here writes a value to localStorage, sessionStorage or IndexedDB.
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { isDevCopy } from "../../../app/model/appIdentity";

import {
  dayOf,
  deleteSecret,
  envFilesFor,
  grantsFor,
  grantLabel,
  copyNotes,
  last4Label,
  listSecrets,
  renameSecret,
  removeEnv,
  revealSecret,
  revokeGrant,
  rotateSecret,
  saveNew,
  scopeLabel,
  SHARED_FILE_NOTE,
  slugIsValid,
  slugOf,
  writeEnv,
  type GrantRow,
  type SecretRow,
} from "../model/secrets";
import { SECRETS_CHANGED } from "./SecretRequestCard";

type Worktree = { path: string; branch?: string | null; isMain?: boolean };

const PLAIN = "text-[12px] text-content/60";
const BUTTON = "text-[12px] text-content/70 hover:text-content";
const INPUT = "rounded border border-content/15 bg-transparent px-2 py-1 text-[13px]";

export function SecretsPage({ project }: { project?: string }) {
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirmReveal, setConfirmReveal] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);

  // A name saved both for everywhere and for a project: say which copy a run uses.
  const copies = copyNotes(rows);

  const load = () => {
    listSecrets()
      // Imported secrets first, each with "Add the value" on its row (step 15).
      .then((all) => setRows([...all].sort((a, b) => Number(b.needsValue) - Number(a.needsValue))))
      .catch((why) => setError(String(why)));
  };

  useEffect(() => {
    load();
    // A preview without the app's bridge has no events; the page still lists what it was given.
    let off: (() => void) | undefined;
    listen(SECRETS_CHANGED, load)
      .then((stop) => {
        off = stop;
      })
      .catch(() => {});
    return () => off?.();
  }, []);

  useEffect(() => {
    if (!project) return;
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<{ worktrees: Worktree[] }>("git_worktrees", { cwd: project }))
      .then((view) => setWorktrees(view.worktrees ?? []))
      .catch(() => setWorktrees([]));
  }, [project]);

  const closeRow = () => {
    setOpen(null);
    setGrants([]);
    setRevealed(null);
    setConfirmReveal(null);
  };

  const showGrants = async (row: SecretRow) => {
    setOpen(`${row.scope}\u0000${row.name}`);
    setRevealed(null);
    setConfirmReveal(null);
    try {
      setGrants(await grantsFor(row.scope, row.name));
    } catch {
      setGrants([]);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className={PLAIN}>
        The keys your agents can use, kept in your Mac's keychain. Never in chats, files or backups.
      </p>
      {isDevCopy() ? (
        <p className={PLAIN}>This is a dev copy, so this list holds the dev keychain's keys, not your daily app's.</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-red-400">
          {error}
        </p>
      ) : null}

      <AddSecret
        project={project}
        open={adding}
        onOpen={() => setAdding(true)}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          load();
        }}
      />

      {rows.some((row) => row.needsValue) ? (
        <p className={PLAIN}>These came from an export. Add each value before anything can use it.</p>
      ) : null}

      {rows.length === 0 ? <p className={PLAIN}>No keys yet.</p> : null}
      <ul className="flex flex-col divide-y divide-content/10">
        {rows.map((row) => {
          const key = `${row.scope}\u0000${row.name}`;
          const twin = copies.get(key);
          const isOpen = open === key;
          return (
            <li key={key} className="py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[13px] text-content">{row.label}</span>
                <span className={PLAIN}>{row.name}</span>
                <span className={PLAIN}>{scopeLabel(row.scope)}</span>
                <span className={PLAIN}>{last4Label(row.last4)}</span>
                <span className={PLAIN}>added {dayOf(row.createdAt)}</span>
                <span className={PLAIN}>last used {dayOf(row.lastUsedAt)}</span>
                {row.needsValue ? <span className="text-[12px] text-content/80">Needs its value</span> : null}
              </div>
              {twin ? <p className={`mt-1 ${PLAIN}`}>{twin}</p> : null}
              <div className="mt-1 flex flex-wrap gap-3">
                {row.needsValue ? <AddValueButton row={row} onDone={load} setError={setError} /> : null}
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() => {
                    setRevealed(null);
                    setConfirmReveal(key);
                  }}
                >
                  Reveal
                </button>
                <button type="button" className={BUTTON} onClick={() => void showGrants(row)}>
                  Approvals
                </button>
                <RenameButton row={row} onDone={load} />
                <RotateButton row={row} onDone={load} setError={setError} />
                <WriteEnvButton row={row} project={project} worktrees={worktrees} onDone={load} setError={setError} />
                <DeleteButton row={row} onDone={() => {
                  closeRow();
                  load();
                }} setError={setError} />
              </div>

              {confirmReveal === key ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-content/10 p-2">
                  <span className={PLAIN}>Show this key on screen? Anyone looking can see it.</span>
                  <button
                    type="button"
                    className={BUTTON}
                    onClick={async () => {
                      try {
                        setRevealed(await revealSecret(row.scope, row.name));
                        setOpen(key);
                      } catch {
                        setError("That key isn't in your keychain any more.");
                      }
                      setConfirmReveal(null);
                    }}
                  >
                    Show it
                  </button>
                  <button type="button" className={BUTTON} onClick={() => setConfirmReveal(null)}>
                    Cancel
                  </button>
                </div>
              ) : null}

              {isOpen && revealed ? (
                <div className="mt-2 flex items-center gap-2">
                  <input readOnly value={revealed} className={`${INPUT} w-full`} aria-label="The key" />
                  <button type="button" className={BUTTON} onClick={closeRow}>
                    Close
                  </button>
                </div>
              ) : null}

              {isOpen && grants.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-1">
                  {grants.map((grant) => (
                    <li key={`${grant.subjectKind}:${grant.subjectId}:${grant.executable}`} className="flex gap-3">
                      <span className={PLAIN}>
                        {grantLabel(grant)} may run <span className="text-content/80">{grant.executable}</span> (
                        {grant.mode === "once" ? "once" : "always"})
                      </span>
                      <button
                        type="button"
                        className={BUTTON}
                        onClick={async () => {
                          await revokeGrant(row.scope, row.name, grant.subjectKind, grant.subjectId, grant.executable);
                          await showGrants(row);
                          load();
                        }}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {isOpen && grants.length === 0 ? <p className={`mt-2 ${PLAIN}`}>No approvals yet: each use asks.</p> : null}
              {isOpen && row.envFiles.length > 0 ? (
                <p className={`mt-2 ${PLAIN}`}>In a .env at {row.envFiles.join(", ")}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AddSecret({
  project,
  open,
  onOpen,
  onClose,
  onSaved,
}: {
  project?: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState(project ? `project.${project}` : "global");
  const [error, setError] = useState<string | null>(null);
  const value = useRef<HTMLInputElement>(null);

  if (!open) {
    return (
      <div>
        <button type="button" className={BUTTON} onClick={onOpen}>
          Add a secret
        </button>
      </div>
    );
  }
  return (
    <section className="rounded border border-content/10 p-3">
      <p className="text-[13px] text-content">Add a secret</p>
      <label className={`mt-2 block ${PLAIN}`} htmlFor="secret-add-name">
        Name (agents ask by this)
      </label>
      <input
        id="secret-add-name"
        className={`mt-1 w-full ${INPUT}`}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {name && !slugIsValid(name) ? (
        <p role="alert" className="mt-1 text-[12px] text-red-400">
          A key's name is lower-case letters, digits and dashes, 1 to 64 characters.
        </p>
      ) : (
        <p className={`mt-1 ${PLAIN}`}>Stored as {slugOf(name) || "…"}</p>
      )}
      <label className={`mt-2 block ${PLAIN}`} htmlFor="secret-add-label">
        Label
      </label>
      <input
        id="secret-add-label"
        className={`mt-1 w-full ${INPUT}`}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
      />
      <label className={`mt-2 block ${PLAIN}`} htmlFor="secret-add-scope">
        Who can use it
      </label>
      <select
        id="secret-add-scope"
        className={`mt-1 w-full ${INPUT}`}
        value={scope}
        onChange={(event) => setScope(event.target.value)}
      >
        <option value="global">{scopeLabel("global")}</option>
        {project ? <option value={`project.${project}`}>{scopeLabel(`project.${project}`)}</option> : null}
      </select>
      <label className={`mt-2 block ${PLAIN}`} htmlFor="secret-add-value">
        The key
      </label>
      <input id="secret-add-value" ref={value} type="password" autoComplete="off" className={`mt-1 w-full ${INPUT}`} />
      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-red-400">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex gap-3">
        <button
          type="button"
          className="rounded bg-content/15 px-3 py-1 text-[12px] text-content"
          onClick={async () => {
            const text = value.current?.value ?? "";
            if (!slugIsValid(name)) {
              setError("A key's name is lower-case letters, digits and dashes, 1 to 64 characters.");
              return;
            }
            try {
              await saveNew(scope, slugOf(name), label.trim() || null, text);
              if (value.current) value.current.value = "";
              onSaved();
            } catch {
              if (value.current) value.current.value = "";
              setError("That key wasn't saved. Try again.");
            }
          }}
        >
          Save
        </button>
        <button type="button" className={BUTTON} onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function RenameButton({ row, onDone }: { row: SecretRow; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(row.label);
  if (!editing) {
    return (
      <button type="button" className={BUTTON} onClick={() => setEditing(true)}>
        Rename
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <input className={INPUT} value={label} onChange={(event) => setLabel(event.target.value)} aria-label="Label" />
      <button
        type="button"
        className={BUTTON}
        onClick={async () => {
          await renameSecret(row.scope, row.name, label, row.version);
          setEditing(false);
          onDone();
        }}
      >
        Save
      </button>
      <button type="button" className={BUTTON} onClick={() => setEditing(false)}>
        Cancel
      </button>
    </span>
  );
}

function RotateButton({
  row,
  onDone,
  setError,
}: {
  row: SecretRow;
  onDone: () => void;
  setError: (error: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [envFiles, setEnvFiles] = useState<string[]>([]);
  const [updateEnv, setUpdateEnv] = useState(false);
  const value = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState<string[]>([]);
  if (!editing) {
    return (
      <button
        type="button"
        className={BUTTON}
        onClick={() => {
          setNotes([]);
          setUpdateEnv(false);
          setEditing(true);
          // Only the files the vault wrote it to; the person still taps.
          envFilesFor(row.scope, row.name)
            .then((files) => setEnvFiles(files.map((file) => file.worktree)))
            .catch(() => setEnvFiles(row.envFiles));
        }}
      >
        Rotate
      </button>
    );
  }
  const count = envFiles.length;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input ref={value} type="password" autoComplete="off" className={INPUT} aria-label="The new key" />
      {count ? (
        <label className={`flex items-center gap-1 ${PLAIN}`}>
          <input type="checkbox" checked={updateEnv} onChange={(event) => setUpdateEnv(event.target.checked)} />
          Update the {count} {count === 1 ? "file" : "files"} that hold it
        </label>
      ) : null}
      <button
        type="button"
        className={BUTTON}
        onClick={async () => {
          try {
            const report = await rotateSecret(row.scope, row.name, null, value.current?.value ?? "", updateEnv);
            if (value.current) value.current.value = "";
            setNotes([
              ...(report.updated.length
                ? [`Updated ${report.updated.length} .env ${report.updated.length === 1 ? "file" : "files"} that hold it.`]
                : []),
              // A hand-edited line is never guessed at; it is named so the person can look.
              ...(report.leftAlone.length
                ? [`Left ${report.leftAlone.length} alone: the line was edited by hand.`]
                : []),
              // A file that no longer passes the checks is left as it was, with the reason.
              ...(report.refused ?? []).map((file) => `${file.worktree}: ${file.why}`),
              ...((report.shared ?? []).length ? [SHARED_FILE_NOTE] : []),
            ]);
            setEditing(false);
            onDone();
          } catch {
            if (value.current) value.current.value = "";
            setError("That key wasn't rotated. Try again.");
          }
        }}
      >
        Save
      </button>
      <button type="button" className={BUTTON} onClick={() => setEditing(false)}>
        Cancel
      </button>
      {notes.map((note) => (
        <span key={note} className={PLAIN}>
          {note}
        </span>
      ))}
    </span>
  );
}

function WriteEnvButton({
  row,
  project,
  worktrees,
  onDone,
  setError,
}: {
  row: SecretRow;
  project?: string;
  worktrees: Worktree[];
  onDone: () => void;
  setError: (error: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  // The list loads after the page opens, so "nothing picked yet" means the first worktree, not an empty path.
  const [picked, setWorktree] = useState("");
  const worktree = picked || worktrees[0]?.path || "";
  const [envName, setEnvName] = useState(row.name.replace(/-/g, "_").toUpperCase());
  const [note, setNote] = useState<string | null>(null);
  if (!project) return null;
  if (!open) {
    return (
      <>
        <button
          type="button"
          className={BUTTON}
          onClick={() => {
            setNote(null);
            setOpen(true);
          }}
        >
          Write to a worktree's .env
        </button>
        {note ? <span className={PLAIN}>{note}</span> : null}
      </>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <select className={INPUT} value={worktree} onChange={(event) => setWorktree(event.target.value)} aria-label="Worktree">
        {worktrees.map((tree) => (
          <option key={tree.path} value={tree.path}>
            {tree.path}
          </option>
        ))}
      </select>
      <input className={INPUT} value={envName} onChange={(event) => setEnvName(event.target.value)} aria-label="Variable name" />
      <button
        type="button"
        className={BUTTON}
        onClick={async () => {
          try {
            const report = await writeEnv(project, worktree, row.scope, row.name, envName);
            // A file the person left readable by other accounts keeps its mode; they are told.
            setNote(report?.readableByOthers ? SHARED_FILE_NOTE : null);
            setOpen(false);
            onDone();
          } catch (why) {
            setError(String(why));
          }
        }}
      >
        Write
      </button>
      <button type="button" className={BUTTON} onClick={() => setOpen(false)}>
        Cancel
      </button>
      <span className={PLAIN}>The key stays in that file until you remove or rotate it.</span>
      {row.envFiles.length ? (
        <button
          type="button"
          className={BUTTON}
          onClick={async () => {
            for (const path of row.envFiles) {
              await removeEnv({ project, worktree: path, scope: row.scope, name: row.name, envName });
            }
            onDone();
          }}
        >
          Remove those lines
        </button>
      ) : null}
    </span>
  );
}

function DeleteButton({
  row,
  onDone,
  setError,
}: {
  row: SecretRow;
  onDone: () => void;
  setError: (error: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className={BUTTON} onClick={() => setConfirming(true)}>
        Delete
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className={PLAIN}>
        Delete {row.label}?{" "}
        {row.approved.length ? `${row.approved.join(", ")} will stop being able to use it.` : ""} Any command or worker
        that uses it will fail until you add it again.
        {row.envFiles.length
          ? ` Its lines in ${row.envFiles.length} .env ${row.envFiles.length === 1 ? "file" : "files"} are removed too.`
          : ""}
      </span>
      <button
        type="button"
        className={BUTTON}
        onClick={async () => {
          try {
            const report = await deleteSecret(row.scope, row.name);
            const left = (report.envLeft ?? []).map((file) => `${file.worktree}: ${file.why}`);
            if (report.keychainKept) {
              setError(
                `That key is gone from Hivra, but your Mac's keychain wouldn't remove the item. Remove "${row.label}" in Keychain Access to be sure it is gone.`,
              );
            } else if (left.length) {
              setError(`That key is deleted. Its line was left in: ${left.join("; ")}`);
            }
            onDone();
          } catch {
            setError("That key wasn't deleted. Try again.");
          }
        }}
      >
        Delete it
      </button>
      <button type="button" className={BUTTON} onClick={() => setConfirming(false)}>
        Keep it
      </button>
    </span>
  );
}

/** An imported secret: it has a row and no value until the person types one (step 15). */
function AddValueButton({
  row,
  onDone,
  setError,
}: {
  row: SecretRow;
  onDone: () => void;
  setError: (error: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const value = useRef<HTMLInputElement>(null);
  if (!editing) {
    return (
      <button type="button" className={BUTTON} onClick={() => setEditing(true)}>
        Add the value
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input
        ref={value}
        type="password"
        autoComplete="off"
        className={INPUT}
        aria-label={`The value for ${row.label}`}
      />
      <button
        type="button"
        className={BUTTON}
        onClick={async () => {
          try {
            await saveNew(row.scope, row.name, row.label, value.current?.value ?? "");
            if (value.current) value.current.value = "";
            setEditing(false);
            onDone();
          } catch (why) {
            if (value.current) value.current.value = "";
            setError(String(why));
          }
        }}
      >
        Save
      </button>
      <button type="button" className={BUTTON} onClick={() => setEditing(false)}>
        Cancel
      </button>
    </span>
  );
}