// WP-138: the chat header says when named files were copied, and when a copy failed.
import { createRoot } from "react-dom/client";
import { newSession } from "../../src/features/sessions/model/session";
import { NewChatWorktreeBanner } from "../../src/features/sessions/ui/NewChatWorktreeBanner";
import "../../src/styles/index.css";

const note = "2 files named in .worktreeinclude are in this worktree.";
const warning = "Could not copy .env into this worktree.";

const copied = {
  ...newSession("claude", "/work/demo"),
  worktreeCwd: "/work/demo/feature",
  branch: "main",
  includeNote: note,
  includeWarning: warning,
};
const plain = {
  ...newSession("claude", "/work/demo"),
  worktreeCwd: "/work/demo/feature",
  branch: "main",
};

createRoot(document.getElementById("root")!).render(
  <>
    <NewChatWorktreeBanner session={copied} />
    <NewChatWorktreeBanner session={plain} />
  </>,
);
