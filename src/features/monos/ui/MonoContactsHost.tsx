// WP-21: the contacts list wired to the roster. Pin, mute, rename and remove read the roster back.

import { useState, useSyncExternalStore } from "react";
import { starterOffers } from "../../hub/model/starterMonos";
import {
  CONTACT_SAVE_LOST,
  contactWriteResult,
  duplicateContactWithFiles,
  editContactProfile,
  listContactRows,
  newContact,
  newContactFromTemplate,
  removeContact,
  setContactMuted,
  setContactPinned,
  type ContactActivity,
} from "../model/contacts";
import { listMonos, monosSnapshot, subscribeMonos } from "../model/mono";
import { MonoContacts } from "./MonoContacts";

/** The Classic rail's Monos list. Unread comes from the rail when the app has it. */
export function MonoContactsHost({ unseen }: { unseen?: ReadonlyMap<string, number> }) {
  const snap = useSyncExternalStore(subscribeMonos, monosSnapshot);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  void snap;
  void revision;

  const settle = () => {
    setNotice(contactWriteResult() === "lost" ? CONTACT_SAVE_LOST : null);
    setRevision((current) => current + 1);
  };

  const activity: Record<string, ContactActivity> = {};
  if (unseen) {
    for (const mono of listMonos()) {
      const count = unseen.get(mono.id);
      if (count) activity[mono.id] = { unread: count };
    }
  }

  return (
    <div className="px-2 pb-2">
      <MonoContacts
        rows={listContactRows(activity)}
        templates={starterOffers().map((offer) => ({ id: offer.id, name: offer.name }))}
        notice={notice}
        onPin={(id, pinned) => {
          setContactPinned(id, pinned);
          settle();
        }}
        onMute={(id, muted) => {
          setContactMuted(id, muted);
          settle();
        }}
        onDuplicate={(id) => {
          void duplicateContactWithFiles(id).then(() => settle());
        }}
        onEditProfile={(id, profile) => {
          editContactProfile(id, profile);
          settle();
        }}
        onRemove={(id) => {
          removeContact(id);
          settle();
        }}
        onNew={() => {
          newContact();
          settle();
        }}
        onNewFromTemplate={(templateId) => {
          newContactFromTemplate(templateId);
          settle();
        }}
      />
    </div>
  );
}
