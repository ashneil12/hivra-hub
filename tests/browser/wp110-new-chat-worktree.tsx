// WP-110: the real setting and the real chat header, on a made-up folder.
import { createRoot } from "react-dom/client";
import { newSession } from "../../src/features/sessions/model/session";
import { NewChatWorktreeBanner } from "../../src/features/sessions/ui/NewChatWorktreeBanner";
import { NewChatWorktreeSetting } from "../../src/features/source-control/ui/NewChatWorktreeSetting";
import "../../src/styles/index.css";

const started = {
  ...newSession("claude", "/work/demo"),
  worktreeCwd: "/work/demo/feature",
  branch: "main",
};
const offered = {
  ...newSession("claude", "/work/demo"),
  workspaceMode: "worktree" as const,
  worktreeBase: "HEAD",
};

createRoot(document.getElementById("root")!).render(
  <>
    <NewChatWorktreeSetting />
    <NewChatWorktreeBanner session={started} />
    <NewChatWorktreeBanner session={offered} />
  </>,
);
