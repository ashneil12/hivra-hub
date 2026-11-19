// G15: the real Pages screen with a first mate's own chat faked the way App.tsx lends it (Home's chat host). New page
// sends the description to that chat; the first mate's page_build there (the real previewFromChat) fills the card.
// window.fixture moves the chat (answer with a page, end the turn without one, busy); window.proof says what was sent.
import { createRoot } from "react-dom/client";
import { setHomeChiefHost, type HomeChiefSession } from "../../src/features/home/model/homeChief";
import { hubData, setHubDataSource } from "../../src/features/hub/model/hubData";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { addMono } from "../../src/features/monos/model/mono";
import { setPagesBackend } from "../../src/features/pages/model/pages";
import { PagesContent } from "../../src/features/pages/ui/PagesView";
import { previewFromChat } from "../../src/features/selfBuild/model/pagesChat";
import "../../src/styles/index.css";

localStorage.clear();
const src = Object.create(hubData()) as HubDataSource;
src.listProjects = () => [];
src.listNeeds = () => [];
setHubDataSource(src);
setPagesBackend("local");
addMono({ id: "ed", name: "Ed", mascot: "letter", color: "#888", projects: [] });

const chat = { busy: false, blocks: [] as HomeChiefSession["blocks"][number][] };
const proof = { sent: [] as { sessionId: string; text: string }[] };
setHomeChiefHost({
  ensure: async (monoId) => ({ id: `chat-${monoId}` }),
  submit: (sessionId, text) => {
    proof.sent.push({ sessionId, text });
    chat.blocks.push({ role: "user", text });
    chat.busy = true;
    return true;
  },
  answer: () => undefined,
  read: (id) => ({ id, busy: chat.busy, blocks: chat.blocks }),
});

const SPEC = {
  kind: "blocks",
  title: "Every agent",
  blocks: [{ kind: "status", title: "Now", state: "ok", line: "3 agents working", detail: "None stuck" }],
};
Object.assign(window, {
  proof,
  fixture: {
    answer: () => previewFromChat({ spec: SPEC, request: "a page of every agent" }, { monoId: "ed", name: "Ed" }),
    endTurn: (text: string) => {
      chat.blocks.push({ role: "assistant", text });
      chat.busy = false;
    },
    busy: (on: boolean) => {
      chat.busy = on;
    },
  },
});

createRoot(document.getElementById("root")!).render(<PagesContent />);
