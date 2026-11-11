// WP-125: the real copy buttons, the real link opener, and chat markdown, on a made-up chat.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { chatLink, promptLink } from "../../src/features/sessions/model/threadLinks";
import { THREAD_LINK_MESSAGE } from "../../src/features/sessions/model/threadLinks";
import {
  CopyThreadLinkButton,
  ThreadLinkNotice,
  useThreadLinkOpener,
} from "../../src/features/sessions/ui/ThreadLinkActions";
import { AgentMarkdown } from "../../src/features/sessions/ui/AgentMarkdown";
import { installFakeTauri } from "./fakeTauri";
import "../../src/styles/index.css";

const CHAT = "11111111-1111-4111-8111-111111111111";
const MISSING_CHAT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "demo";

const openedUrls: string[] = [];
window.__wp125OpenedUrls = openedUrls;
installFakeTauri("wp125", (command, args) => {
  if (command === "plugin:opener|open_url" && typeof args.url === "string") {
    openedUrls.push(args.url);
  }
  return null;
});

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: async () => {} },
});

function Page() {
  const [prompt, setPrompt] = useState("");
  useThreadLinkOpener({
    hasChat: (id) => id === CHAT,
    hasProject: (id) => id === PROJECT,
    openChat: () => {},
    openPrompt: (_projectId, text) => setPrompt(text),
  });
  return (
    <>
      <h1>Demo chat</h1>
      <header>
        <CopyThreadLinkButton kind="chat" label="Copy chat link" url={chatLink(CHAT)} />
      </header>
      <label>
        Prompt
        <textarea aria-label="Prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      </label>
      <CopyThreadLinkButton
        kind="prompt"
        label="Copy prompt link"
        prepare={async () => {
          const url = promptLink(PROJECT, prompt);
          return url ? { url } : { error: THREAD_LINK_MESSAGE.cannotCopy };
        }}
      />
      <AgentMarkdown
        text={`[Open missing chat](hivra://local/chat/${MISSING_CHAT})\n\n[A web page](https://example.com/notes)`}
      />
      <ThreadLinkNotice />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);

declare global {
  interface Window {
    __wp125OpenedUrls?: string[];
  }
}
