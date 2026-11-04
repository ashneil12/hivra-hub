// r65: PM's 0.16.5 findings (pm-r63-results.md) and Critiquito's steer, one test per item not covered elsewhere.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { briefView, plainBriefText } from "../sessions/model/briefView";
import { listTitle } from "../../shared/text/plainTitle";
import { provideNeeded } from "./model/chatQuestions";
import { NOT_ASKED, WAITING_ALLOW, refusal } from "../pages/model/bridge";
import { failedNextStep, oneCardPerJob } from "../monos/ui/StuckWorkerCard";
import type { StuckWorker } from "../monos/model/workerStuck";
import { monoState } from "../monos/model/mono";
import type { Block } from "../sessions/model/session";

const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const BRIEF = `[MonoCode brief from Hivra lead]
**Ash's words, verbatim:** "can u get someone to wire Stripe checkout"

Read /Users/ash/agent-memory/projects/hivra.md and ~/.claude/settings.local.json first.

<worker_rules>
Never push. Ask before deleting.
</worker_rules>
Done when: checkout works.
<project_memory>
Hivra uses Next 15. Keys live in /Users/ash/.env
</project_memory>`;

describe("#1 the brief folds behind one Brief line, with no tags or paths", () => {
  it("shows the sender and the job, never tags, memory, rules or paths", () => {
    const view = briefView(BRIEF)!;
    expect(view.from).toBe("Hivra lead");
    expect(view.job).not.toMatch(/\*\*|verbatim|Ash's words/);
    for (const raw of ["<worker_rules>", "</project_memory>", "/Users/ash", "~/.claude", "Never push", "Next 15"])
      expect(view.body, raw).not.toContain(raw);
    expect(plainBriefText("see /tmp/x.log and <foo>bar</foo>")).toBe("see a local file and");
  });
  it("is folded by default in the chat", () => {
    const transcript = src("../sessions/ui/AgentTranscript.tsx");
    expect(transcript).toContain("data-brief");
    expect(transcript).toMatch(/<details[^>]*data-brief/);
    expect(transcript).not.toMatch(/<details[^>]*data-brief[^>]*\bopen\b/);
  });
  it("is not a brief when it doesn't start like one", () => {
    expect(briefView("hello")).toBeUndefined();
  });
});

describe("#2 and #3: titles and CoS lines are plain", () => {
  it("a worker title is the job, without a quote prefix or bold marks", () => {
    expect(listTitle('Ash\'s words, verbatim: "can u get someone to wire Stripe checkout"')).toBe("can u get someone to wire Stripe checkout");
    expect(listTitle("**Wire** Stripe checkout")).toBe("Wire Stripe checkout");
    expect(listTitle("[MonoCode brief from Hivra lead] Fix the login page")).toBe("Fix the login page");
  });
  it("the new-project question renders markdown", () => {
    expect(src("./ui/NewProjectView.tsx")).toContain("AgentMarkdown");
  });
});

describe("#4 a key only Ash can make is a provide card, no Approve or Deny", () => {
  it("reads what is needed", () => {
    expect(provideNeeded("Can you provide a Stripe live secret key?")).toMatch(/stripe live secret key/i);
    expect(provideNeeded("Grant git access to the hivra repo")).toMatch(/git access/);
    expect(provideNeeded("Approve the deploy to prod?")).toBeUndefined();
    expect(provideNeeded("Stripe key please", "provide")).toBeDefined();
  });
});

describe("#5 a Lead's question to Ash is red, and every Inbox ask row is red", () => {
  it("an idle Lead ending on an admitted Needs Ash ask is needs-you", () => {
    const blocks: Block[] = [
      { id: "a", role: "assistant", text: "I wired the form.\n\nNeeds Ash (provide): a Stripe live secret key for Hivra, so checkout can charge." } as Block,
    ];
    expect(monoState({ blocks, busy: false }).status).toBe("needs-you");
    expect(monoState({ blocks: [{ id: "b", role: "assistant", text: "All done." } as Block], busy: false }).status).toBe("idle");
  });
});

describe("#6 the Agents page: no permission ids, no loading and error together", () => {
  it("asked but not allowed says it's waiting; never names agents.read", () => {
    expect(refusal({ call: "agents.read" }, [], ["agents.read"] as never)).toBe(WAITING_ALLOW);
    expect(refusal({ call: "agents.read" }, [], [])).toBe(NOT_ASKED);
    expect(refusal({ call: "agents.read" }, ["agents.read"] as never)).toBeUndefined();
    for (const copy of [WAITING_ALLOW, NOT_ASKED]) expect(copy).not.toMatch(/agents\.read|'[a-z]+\.[a-z]+'/);
  });
  it("the error path hides 'Reading your agents…'", () => {
    const ready = src("../pages/model/readyPages.ts");
    expect(ready.match(/\$\("\[data-summary\]"\)\.hidden = true/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe("#11 the Stopped-with-an-error card: one per job, opaque, with a next step", () => {
  const row = (id: string, title: string, owner = "lead-1") =>
    ({ row: { id, title, ownerSession: owner } as never, kind: "failed", line: "Stopped with an error.", since: 0, escalated: false, key: id }) as StuckWorker;
  it("three failures of one job are one card", () => {
    const cards = oneCardPerJob([row("w3", "Wire Stripe"), row("w2", "Wire stripe"), row("w1", "Wire Stripe"), row("x", "Docs")]);
    expect(cards.map((c) => c.key)).toEqual(["w3", "x"]);
    expect(oneCardPerJob([row("a", "Same", "lead-1"), row("b", "Same", "lead-2")])).toHaveLength(2);
  });
  it("says what happens next in plain words", () => {
    expect(failedNextStep("Hivra lead")).toBe("Hivra lead hands it to a fresh worker once, and tells you if that fails too.");
  });
  it("the card is opaque with a blur behind it, so chat text never shows through", () => {
    const card = src("../monos/ui/StuckWorkerCard.tsx");
    expect(card).toContain("backdrop-blur-xl");
    expect(card).toContain("bg-background-base/95");
    expect(card).toContain("data-stuck-next");
  });
});
