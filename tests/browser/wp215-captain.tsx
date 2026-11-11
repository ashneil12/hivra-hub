// Browser proof for the captain (WP-215). Example rows only. The charter text stays off the page.
import { useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { captainDecide, handoffLine, suggestLine } from "../../src/features/chief/model/captain";
import { CAPTAIN_CHARTER, applyPersonality, personalityOf } from "../../src/features/chief/model/charter";
import { CaptainPersonality } from "../../src/features/chief/ui/CaptainPersonality";
import type { FirstMateItem } from "../../src/features/crew/model/inbox";
import { FirstMateInbox } from "../../src/features/crew/ui/FirstMateInbox";
import { RoomMessage } from "../../src/features/hub/ui/RoomMessage";
import type { ChatMessage } from "../../src/features/hub/model/types";
import "../../src/styles/index.css";

const soul = `# Soul\n\n## Role\n${CAPTAIN_CHARTER}\n\n## Personality\nWarm and brief.\n\n## Who I am\nI am the coordinator.\n`;

const standing = captainDecide({
  project: "Hivra",
  monoId: "ada",
  question: "Example: keep the gate?",
  options: ["Example: keep it", "Example: change it"],
  recommendation: "Example: change it",
  confident: true,
  standing: { answer: "Example: keep it", label: "merge on green" },
  switchOn: true,
  now: 1_000,
});

const passed = captainDecide({
  project: "EXO",
  monoId: "ada",
  question: "Example: retry the check?",
  options: ["Example: retry once", "Example: leave it"],
  recommendation: "Example: leave it",
  switchOn: true,
  now: 1_000,
  turn: () => ({ passUp: true, suggest: "Example: retry once", reason: "it can wait" }),
});

const handoff = handoffLine("Coding", "Example: tighten the gate");
const suggestion = passed.kind === "ask-owner" && passed.line ? passed.line : suggestLine("Example: retry once");
const reason = passed.kind === "ask-owner" ? passed.reason : "";
const answer = standing.kind === "answer" ? standing.answer : "";
const why = standing.kind === "answer" ? standing.reason : "";

const handoffMessage: ChatMessage = { id: "handoff", from: "app", kind: "system", text: handoff };

const passedUp: FirstMateItem = {
  id: "pass",
  kind: "question",
  title: "Example: retry the check?",
  body: reason,
  statusWord: suggestion,
  chatId: null,
  workerIds: [],
  options: [],
  recommended: null,
  project: "EXO",
  key: null,
  since: 0,
  updatedAt: 1,
};

function Page() {
  const passRef = useRef<HTMLDivElement>(null);
  const kept = applyPersonality(soul, personalityOf(soul)).includes(CAPTAIN_CHARTER);
  useLayoutEffect(() => {
    const lines = passRef.current?.querySelectorAll("article p");
    lines?.[0]?.setAttribute("data-testid", "passup");
    lines?.[1]?.setAttribute("data-testid", "passup-reason");
  }, []);
  return (
    <main className="min-h-screen bg-background-base text-content">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
        <h1 className="text-[22px] font-medium text-content">Hivra</h1>
        <section className="rounded-lg border border-stroke px-3 py-3" data-testid="handoff">
          <RoomMessage chatId="room" message={handoffMessage} messages={[handoffMessage]} nameOf={() => "App"} />
        </section>
        <section className="rounded-lg border border-stroke">
          <h2 className="px-3 pt-3 text-[13px] font-medium text-content">Needs you</h2>
          <div ref={passRef}>
            <FirstMateInbox items={[passedUp]} />
          </div>
        </section>
        <section className="rounded-lg border border-stroke">
          <h2 className="px-3 pt-3 text-[13px] font-medium text-content">Decided for you</h2>
          <div className="px-3 py-2.5">
            <div className="break-words text-[13px] leading-5 text-content">Example: keep the gate?</div>
            <div className="break-words text-[13px] leading-5 text-content" data-testid="standing-answer">
              {answer}
            </div>
            <div className="text-xs text-content/60" data-testid="standing-reason">
              {why}
            </div>
          </div>
        </section>
        <section className="rounded-lg border border-stroke">
          <CaptainPersonality monoId="ada" soul={soul} />
          <p className="sr-only" data-testid="personality">
            {personalityOf(soul)}
          </p>
          <p className="sr-only" data-testid="charter-kept">
            {kept ? "The charter stays as it is." : "The charter moved."}
          </p>
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
