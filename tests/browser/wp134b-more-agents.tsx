// WP-134b: the More agents setting, on its own page. The list lives in the app (Tauri commands, more_agents.rs). This page
// stands in for those commands with a list kept in this browser, so the setting can be driven without the app.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MoreAgentsSettings } from "../../src/features/registry/ui/MoreAgentsSettings";
import {
  START_REGISTRY_CHAT_EVENT,
  refreshRegistry,
  reportRegistryChatRefused,
  loadRegistryDocument,
} from "../../src/features/registry/model/registryList";
import "../../src/styles/index.css";

const LIST_KEY = "wp134b-list";

// approvedFp keeps what the person allowed for each id: the fingerprint of the command and arguments, as the app does.
type Doc = { revision: number; agents: unknown[]; approved: string[]; approvedFp?: Record<string, string> };

type Entry = { id: string; command: string; args: string[] };

// The same fingerprint idea as more_agents.rs: the command and its arguments, joined unambiguously.
function fingerprintOf(entry: Entry): string {
  return JSON.stringify([entry.command, ...entry.args]);
}

// What the app's view returns: the ids allowed as they are now, and what the window must send back to allow each.
function view(doc: Doc) {
  const entries = (doc.agents as Entry[]).filter((agent) => typeof agent?.id === "string");
  const fingerprints: Record<string, string> = {};
  const resolved: Record<string, string | null> = {};
  for (const entry of entries) {
    fingerprints[entry.id] = fingerprintOf(entry);
    resolved[entry.id] = entry.command.startsWith("/") ? entry.command : null;
  }
  const approved = doc.approved.filter((id) => doc.approvedFp?.[id] === fingerprints[id]);
  return { revision: doc.revision, agents: doc.agents, approved, fingerprints, resolved };
}

function readDoc(): Doc {
  try {
    const text = localStorage.getItem(LIST_KEY);
    if (text) return JSON.parse(text) as Doc;
  } catch {
    // An unreadable stand-in list starts empty, as a missing one does.
  }
  return { revision: 0, agents: [], approved: [], approvedFp: {} };
}

function writeDoc(doc: Doc) {
  localStorage.setItem(LIST_KEY, JSON.stringify(doc));
}

// The same commands the app answers (src-tauri/src/more_agents.rs), with the same revision check.
window.__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    const doc = readDoc();
    if (cmd === "more_agents_read") return view(doc);
    if (cmd === "more_agents_write") {
      if (args.expectedRevision !== doc.revision) {
        throw new Error("The list changed in another window (revision). Reload it and try again.");
      }
      const agents = args.agents as { id: string }[];
      const next: Doc = {
        revision: doc.revision + 1,
        agents,
        approved: doc.approved.filter((id) => agents.some((agent) => agent.id === id)),
        approvedFp: Object.fromEntries(
          Object.entries(doc.approvedFp ?? {}).filter(([id]) => agents.some((agent) => agent.id === id)),
        ),
      };
      writeDoc(next);
      return view(next);
    }
    if (cmd === "more_agents_approve") {
      const id = String(args.id);
      const entry = (doc.agents as Entry[]).find((agent) => agent.id === id);
      if (!entry) throw new Error("This agent is not in your list.");
      const approvedFp = { ...(doc.approvedFp ?? {}) };
      let approved = doc.approved.filter((item) => item !== id);
      if (args.allowed) {
        // The allow must name the entry as the window showed it; a changed entry is refused.
        if (args.shown !== fingerprintOf(entry)) {
          throw new Error("This agent changed since you looked at it. Review it again before you allow it.");
        }
        approved = [...approved, id];
        approvedFp[id] = fingerprintOf(entry);
      } else {
        delete approvedFp[id];
      }
      const next: Doc = { ...doc, approved, approvedFp };
      writeDoc(next);
      return view(next);
    }
    if (cmd === "more_agents_check") {
      const id = String(args.id);
      if (!view(doc).approved.includes(id)) throw new Error("This agent is not approved to run. Allow it in More agents first.");
      return null;
    }
    throw new Error(`Unexpected command in this page: ${cmd}`);
  },
} as unknown as Window["__TAURI_INTERNALS__"];

function Page() {
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => {
    // The app's Start a chat handler reads the app's list first and refuses an entry that is not allowed as it is.
    const onAsk = async (event: Event) => {
      const id = (event as CustomEvent<{ agentId?: string }>).detail?.agentId;
      await refreshRegistry();
      const entry = loadRegistryDocument().agents.find((agent) => agent.id === id);
      if (!entry) return reportRegistryChatRefused("This agent is no longer in your list.");
      if (!entry.approved) return reportRegistryChatRefused("This agent is not approved to run. Allow it in More agents first.");
      setAsked(entry.id);
    };
    window.addEventListener(START_REGISTRY_CHAT_EVENT, onAsk);
    return () => window.removeEventListener(START_REGISTRY_CHAT_EVENT, onAsk);
  }, []);
  return (
    <>
      <MoreAgentsSettings />
      {asked ? <p data-chat-request={asked}>Chat requested</p> : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
