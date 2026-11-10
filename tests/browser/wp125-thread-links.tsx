// WP-125: the real copy buttons and the real link opener, on a made-up chat.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { chatLink, promptLink } from "../../src/features/sessions/model/threadLinks";
import { THREAD_LINK_MESSAGE } from "../../src/features/sessions/model/threadLinks";
import {
  CopyThreadLinkButton,
  ThreadLinkNotice,
  useThreadLinkOpener,
} from "../../src/features/sessions/ui/ThreadLinkActions";
import "../../src/styles/index.css";

const CHAT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "demo";

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
      <a href="hivra://local/chat/22222222-2222-4222-8222-222222222222">Open missing chat</a>
      <ThreadLinkNotice />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
