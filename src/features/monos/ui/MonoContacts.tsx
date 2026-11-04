// WP-21: one list of Monos as contacts. The menu pins, mutes, duplicates, edits the profile or removes.

import { useState } from "react";
import type { ContactRow } from "../model/contacts";

export type ContactTemplate = { id: string; name: string };

type Props = {
  rows: readonly ContactRow[];
  templates: readonly ContactTemplate[];
  onPin: (id: string, pinned: boolean) => void;
  onMute: (id: string, muted: boolean) => void;
  onDuplicate: (id: string) => void;
  onEditProfile: (id: string, profile: { name: string; title: string }) => void;
  onRemove: (id: string) => void;
  onNew: () => void;
  onNewFromTemplate: (templateId: string) => void;
  /** A save that did not stay on the roster. */
  notice?: string | null;
};

export function MonoContacts({
  rows,
  templates,
  onPin,
  onMute,
  onDuplicate,
  onEditProfile,
  onRemove,
  onNew,
  onNewFromTemplate,
  notice,
}: Props) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [adding, setAdding] = useState(false);

  const openEdit = (row: ContactRow) => {
    setMenuId(null);
    setEditing(row.id);
    setDraftName(row.name);
    setDraftTitle(row.title);
  };

  return (
    <section aria-label="Monos" data-mono-contacts>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Monos</h2>
        <button type="button" className="text-sm underline" onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
          New Mono
        </button>
      </div>
      {adding ? (
        <div className="mb-3 flex flex-col gap-1" data-new-mono>
          <button type="button" className="text-left text-sm" onClick={() => { onNew(); setAdding(false); }}>
            New from scratch
          </button>
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className="text-left text-sm"
              onClick={() => { onNewFromTemplate(template.id); setAdding(false); }}
            >
              {`New from ${template.name}`}
            </button>
          ))}
          {templates.length === 0 ? <p className="text-sm">No templates yet.</p> : null}
        </div>
      ) : null}
      {notice ? <p className="mb-2 text-sm" data-contact-notice>{notice}</p> : null}
      {rows.length === 0 ? <p className="text-sm">No Monos yet.</p> : null}
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.id} className="relative" data-contact={row.id} data-pinned={row.pinned ? "true" : "false"}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium" data-contact-name>{row.name}</span>
                  {row.title ? <span className="truncate text-xs opacity-70" data-contact-title>{row.title}</span> : null}
                  {row.unread > 0 ? (
                    <span className="text-xs" data-contact-unread>{row.unread > 99 ? "99+" : String(row.unread)}</span>
                  ) : null}
                </div>
                <p className="truncate text-xs opacity-70" data-contact-last>{row.lastLine}</p>
              </div>
              <button
                type="button"
                className="text-xs underline"
                aria-haspopup="menu"
                aria-expanded={menuId === row.id}
                aria-label={`Menu for ${row.name}`}
                onClick={() => setMenuId((current) => (current === row.id ? null : row.id))}
              >
                Menu
              </button>
            </div>
            {menuId === row.id ? (
              <div role="menu" aria-label={`Menu for ${row.name}`} className="mt-1 flex flex-col gap-1 rounded border p-2">
                <button type="button" role="menuitem" onClick={() => { onPin(row.id, !row.pinned); setMenuId(null); }}>
                  {row.pinned ? "Unpin" : "Pin"}
                </button>
                <button type="button" role="menuitem" onClick={() => { onMute(row.id, !row.muted); setMenuId(null); }}>
                  {row.muted ? "Unmute" : "Mute"}
                </button>
                <button type="button" role="menuitem" onClick={() => { onDuplicate(row.id); setMenuId(null); }}>
                  Duplicate
                </button>
                <button type="button" role="menuitem" onClick={() => openEdit(row)}>
                  Edit profile
                </button>
                <button type="button" role="menuitem" onClick={() => { onRemove(row.id); setMenuId(null); }}>
                  Remove
                </button>
              </div>
            ) : null}
            {editing === row.id ? (
              <form
                className="mt-1 flex flex-col gap-1"
                data-edit-profile={row.id}
                onSubmit={(event) => {
                  event.preventDefault();
                  onEditProfile(row.id, { name: draftName, title: draftTitle });
                  setEditing(null);
                }}
              >
                <label className="text-xs">
                  Name
                  <input className="ml-2 border bg-transparent px-1" value={draftName} onChange={(event) => setDraftName(event.target.value)} />
                </label>
                <label className="text-xs">
                  Title
                  <input className="ml-2 border bg-transparent px-1" value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
                </label>
                <button type="submit">Save profile</button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
