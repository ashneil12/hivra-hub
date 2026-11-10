// WP-134b: the More agents setting, on its own page. The list lives in the app (Tauri commands, more_agents.rs). This page
// stands in for those commands with a list kept in this browser, so the setting can be driven without the app.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MoreAgentsSettings } from "../../src/features/registry/ui/MoreAgentsSettings";
import { START_REGISTRY_CHAT_EVENT } from "../../src/features/registry/model/registryList";
import "../../src/styles/index.css";

const LIST_KEY = "wp134b-list";

type Doc = { revision: number; agents: unknown[]; approved: string[] };

function readDoc(): Doc {
  try {
    const text = localStorage.getItem(LIST_KEY);
    if (text) return JSON.parse(text) as Doc;
  } catch {
    // An unreadable stand-in list starts empty, as a missing one does.
  }
  return { revision: 0, agents: [], approved: [] };
}

function writeDoc(doc: Doc) {
  localStorage.setItem(LIST_KEY, JSON.stringify(doc));
}

// The same commands the app answers (src-tauri/src/more_agents.rs), with the same revision check.
window.__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    const doc = readDoc();
    if (cmd === "more_agents_read") return doc;
    if (cmd === "more_agents_write") {
      if (args.expectedRevision !== doc.revision) {
        throw new Error("The list changed in another window (revision). Reload it and try again.");
      }
      const agents = args.agents as { id: string }[];
      const next: Doc = {
        revision: doc.revision + 1,
        agents,
        approved: doc.approved.filter((id) => agents.some((agent) => agent.id === id)),
      };
      writeDoc(next);
      return next;
    }
    if (cmd === "more_agents_approve") {
      const id = String(args.id);
      const approved = args.allowed
        ? [...doc.approved.filter((item) => item !== id), id]
        : doc.approved.filter((item) => item !== id);
      const next = { ...doc, approved };
      writeDoc(next);
      return next;
    }
    throw new Error(`Unexpected command in this page: ${cmd}`);
  },
} as unknown as Window["__TAURI_INTERNALS__"];

function Page() {
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => {
    const onAsk = (event: Event) => {
      const id = (event as CustomEvent<{ agentId?: string }>).detail?.agentId;
      setAsked(typeof id === "string" ? id : "");
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
