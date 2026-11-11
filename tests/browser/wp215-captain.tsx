// Browser proof for the captain (WP-215). Example rows only. The charter text stays off the page.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { captainDecide, handoffLine, suggestLine } from "../../src/features/chief/model/captain";
import { CAPTAIN_CHARTER, applyPersonality, personalityOf } from "../../src/features/chief/model/charter";
import "../../src/styles/index.css";

const soul = `# Soul\n\n## Role\n${CAPTAIN_CHARTER}\n\n## Personality\n\n## Who I am\nI am the coordinator.\n\n## Every project\n\nEvery project: read\n`;

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

function Page() {
  const [text, setText] = useState("Warm and brief.");
  const next = applyPersonality(soul, text);
  const kept = next.includes(CAPTAIN_CHARTER) && next.indexOf(CAPTAIN_CHARTER) === soul.indexOf(CAPTAIN_CHARTER);
  const handoff = handoffLine("Coding", "Example: tighten the gate");
  const suggestion = passed.kind === "ask-owner" && passed.line ? passed.line : suggestLine("Example: retry once");
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>Hivra</h1>
      <p data-testid="handoff">{handoff}</p>
      <section>
        <h2 style={{ fontSize: 16 }}>Example: keep the gate?</h2>
        <p data-testid="standing-answer">{standing.kind === "answer" ? standing.answer : ""}</p>
        <p data-testid="standing-reason">{standing.kind === "answer" ? standing.reason : ""}</p>
      </section>
      <section>
        <h2 style={{ fontSize: 16 }}>Example: retry the check?</h2>
        <p data-testid="passup">{suggestion}</p>
        <p data-testid="passup-reason">{passed.kind === "ask-owner" ? passed.reason : ""}</p>
      </section>
      <section>
        <h2 style={{ fontSize: 16 }}>Personality</h2>
        <p>How the Chief of Staff sounds. The charter stays as it is.</p>
        <textarea aria-label="Personality" value={text} onChange={(event) => setText(event.target.value)} />
        <p data-testid="personality">{personalityOf(next)}</p>
        <p data-testid="charter-kept">{kept ? "The charter stays as it is." : "The charter moved."}</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
