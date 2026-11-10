// WP-121: the real continue and recap lines, and the real timeline marker.
import { createRoot } from "react-dom/client";
import { applyMidThreadSwitch } from "../../src/features/sessions/model/midThreadSwitch";
import { newSession, type Block } from "../../src/features/sessions/model/session";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import { MidThreadSwitchNotice } from "../../src/features/sessions/ui/MidThreadSwitchNotice";
import "../../src/styles/index.css";

const user: Block = { id: "u1", role: "user", text: "keep going" };

function switched(harness: "codex" | "fx", model: string) {
  return applyMidThreadSwitch(
    { ...newSession("claude", "/work/demo"), blocks: [user] },
    { harness, model, modelSettings: {} },
  ).session;
}

const resume = switched("codex", "codex:gpt-5");
const recap = switched("fx", "fx:default");
const quiet = newSession("claude", "/work/demo");

function Chat({
  title,
  line,
  blocks,
}: {
  title: string;
  line?: string;
  blocks?: Block[];
}) {
  return (
    <section>
      <h2>{title}</h2>
      <MidThreadSwitchNotice line={line} place="header" />
      <MidThreadSwitchNotice line={line} place="composer" />
      {blocks ? (
        <div style={{ height: 180 }}>
          <AgentTranscript blocks={blocks} visible />
        </div>
      ) : null}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <>
    <h1>Mid-thread switch</h1>
    <Chat title="Resume" line={resume.midThread?.line} blocks={resume.blocks} />
    <Chat title="Recap" line={recap.midThread?.line} />
    <Chat title="Quiet" line={quiet.midThread?.line} />
  </>,
);
