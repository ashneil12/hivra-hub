// WP-111: the private label and the menu words, on a chat this page holds.

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { withPrivate } from "../../src/features/memory/model/privateChat";
import { PrivateMark } from "../../src/features/sessions/ui/PrivateMark";
import "../../src/styles/index.css";

type Chat = { id: string; private?: boolean; privateBoundaryId?: string; blocks: { id: string }[] };

function Harness() {
  const [chat, setChat] = useState<Chat>({
    id: "chat-1",
    blocks: [{ id: "m1" }, { id: "m2" }],
  });
  const on = chat.private === true;
  return (
    <div>
      <PrivateMark on={on} />
      <button
        type="button"
        onClick={() => setChat((current) => withPrivate(current, !on))}
      >
        {on ? "Not private" : "Private"}
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
