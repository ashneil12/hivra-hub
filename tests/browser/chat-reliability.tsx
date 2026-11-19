import { BackgroundResultNotice } from "../../src/features/sessions/ui/BackgroundResultNotice";
import { createRoot } from "react-dom/client";
import { ChiefAsked } from "../../src/features/asks/ui/ChiefGlance";
import { askStore } from "../../src/features/asks/model/askStore";
import { LaunchedSessionCard } from "../../src/features/monos/ui/LaunchedSessionCard";
import "../../src/styles/index.css";

const store = askStore();
await store.load();
for (const [blockId, text] of [
  ["open", "Example: fix the invoice export dates"],
  ["closed", "Example: explain the weekly summary"],
]) {
  await store.add({
    mateId: "example",
    sessionId: "example-chat",
    blockId,
    text,
  });
}
await store.change(
  store.doc().asks[1].id,
  { status: "done", proof: "Example: answered in this chat" },
  "ash",
);
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle(
  "theme-light",
  params.get("scheme") === "light",
);
const width = Number(params.get("width") ?? 380);
createRoot(document.getElementById("root")!).render(
  <main
    className="p-4 font-sans text-content"
    style={{ width, maxWidth: "100%" }}
  >
    <div data-worker-row className="flex min-w-0 items-center gap-1.5">
      <LaunchedSessionCard
        launch={{
          sessionId: "example-worker",
          title:
            "Example: unanswered questions stay until answered and finished asks leave the active list",
          cwd: "/example/project",
          harness: "claude",
          model: "claude:opus",
        }}
        view={{
          state: "waiting",
          title:
            "Example: unanswered questions stay until answered and finished asks leave the active list",
        }}
      />
      <button className="shrink-0">Stop</button>
    </div>
    <BackgroundResultNotice text="<system-notice>Background job has completed. Command timed out after 300 seconds.</system-notice>" />
    <ChiefAsked
      onQuote={(text) => {
        document.querySelector("textarea")!.value = text;
      }}
    />
    <textarea aria-label="Example: composer" className="w-full" />
  </main>,
);
