import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TeleportHeaderBand, TeleportNotice, TeleportSendRefusal } from "../../src/features/connections/ui/TeleportNotice";
import "../../src/styles/index.css";

// WP-177: the three notices a chat move can show. The recap button records that the existing recap was asked for.
function Fixture() {
  const [recap, setRecap] = useState("");
  return (
    <main style={{ maxWidth: 560 }}>
      <div id="on-host">
        <TeleportNotice kind="on-host" host="Studio box" time="10 Nov 2026, 09:00" />
      </div>
      <div id="header">
        <TeleportHeaderBand host="Studio box" time="10 Nov 2026, 09:00" />
        <TeleportSendRefusal reason="This chat moved to Studio box. Nothing was sent. Move it back to continue here." />
      </div>
      <div id="turn-running">
        <TeleportNotice
          kind="refused"
          refusal={{ reason: "turn-running", message: "This chat is still working on a turn. It can move once that turn finishes." }}
        />
      </div>
      <div id="cannot-resume">
        <TeleportNotice
          kind="refused"
          refusal={{
            reason: "cannot-resume",
            message: "The other machine cannot resume this chat's transcript: this host does not run claude. Start a new chat from a recap instead.",
            recapOffered: true,
          }}
          onRecap={() => setRecap("Recap requested")}
        />
        <p data-testid="recap-state">{recap}</p>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
