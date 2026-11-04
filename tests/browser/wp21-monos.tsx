import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  duplicateContact,
  editContactProfile,
  listContactRows,
  newContact,
  newContactFromTemplate,
  removeContact,
  setContactMuted,
  setContactPinned,
  type ContactActivity,
} from "../../src/features/monos/model/contacts";
import { updateMono } from "../../src/features/monos/model/mono";
import { starterOffers } from "../../src/features/hub/model/starterMonos";
import { MonoContacts } from "../../src/features/monos/ui/MonoContacts";
import "../../src/styles/index.css";

const activity = new Map<string, ContactActivity>();

function seed() {
  if (localStorage.getItem("wp21-seeded")) return;
  const ada = newContact(["/work/My Project"]);
  updateMono(ada.id, (mono) => ({ ...mono, name: "Ada", role: "Design review", pinned: true }));
  const milo = newContact();
  updateMono(milo.id, (mono) => ({ ...mono, name: "Milo", role: "Notes", muted: true }));
  activity.set(ada.id, { lastLine: "The screen is too crowded.", unread: 2 });
  activity.set(milo.id, { lastLine: "Nothing new.\r\nsecret second line", unread: 4 });
  localStorage.setItem("wp21-seeded", "1");
  localStorage.setItem("wp21-activity", JSON.stringify([...activity.entries()]));
}

function loadActivity() {
  activity.clear();
  try {
    const raw = JSON.parse(localStorage.getItem("wp21-activity") ?? "[]") as [string, ContactActivity][];
    for (const [id, value] of raw) activity.set(id, value);
  } catch {
    // A bad saved list is no activity, not a crash.
  }
}

seed();
loadActivity();

function activityRecord(): Record<string, ContactActivity> {
  return Object.fromEntries(activity);
}

function Page() {
  const [tick, setTick] = useState(0);
  const refresh = () => {
    localStorage.setItem("wp21-activity", JSON.stringify([...activity.entries()]));
    setTick((n) => n + 1);
  };
  const rows = listContactRows(activityRecord());
  void tick;
  return (
    <MonoContacts
      rows={rows}
      templates={starterOffers().map((offer) => ({ id: offer.id, name: offer.name }))}
      onPin={(id, pinned) => { setContactPinned(id, pinned); refresh(); }}
      onMute={(id, muted) => { setContactMuted(id, muted); refresh(); }}
      onDuplicate={(id) => { duplicateContact(id); refresh(); }}
      onEditProfile={(id, profile) => { editContactProfile(id, profile); refresh(); }}
      onRemove={(id) => { removeContact(id); activity.delete(id); refresh(); }}
      onNew={() => { newContact(); refresh(); }}
      onNewFromTemplate={(templateId) => { newContactFromTemplate(templateId); refresh(); }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
