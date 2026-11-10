// WP-134b: the More agents setting, on its own page.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MoreAgentsSettings } from "../../src/features/registry/ui/MoreAgentsSettings";
import { START_REGISTRY_CHAT_EVENT } from "../../src/features/registry/model/registryList";
import "../../src/styles/index.css";

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
