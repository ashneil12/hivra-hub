import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HomeScreen } from "../../src/features/home/ui/HomeScreen";
import { defaultArrangement } from "../../src/features/home/model/arrangement";
import { NeedsRollupCard } from "../../src/features/asks/ui/InlineNeed";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import { progressNote, PROGRESS_QUIET_MS } from "../../src/features/monos/model/progressNote";
import type { Session } from "../../src/features/sessions/model/session";
import type { Delegation } from "../../src/features/monos/model/delegations";
import "../../src/styles/index.css";
const progress = progressNote({id: "example-lead", blocks: []} as unknown as Session, [{id: "example-job", ownerSession: "example-lead", createdAt: 1, state: "running"} as Delegation], PROGRESS_QUIET_MS + 2)!;
progress.text = `Example: ${progress.text.toLowerCase()}`;
function Example() {
  const [failed, setFailed] = useState(false);
  return <main className="flex h-screen flex-col text-content">
    <button onClick={() => setFailed(true)}>Example: native read times out</button>
    <HomeScreen known={false} failed={failed} chief={{ missing: true, name: "Example: coordinator", options: [], onAdd() {}, onOpenChat() {}, onOption() {} }} needs={[]} needsTotal={0} builders={[]} working={[]} workingTotal={0} done={[]} onSeeNeeds={() => {}} onSeeDone={() => {}} arrangement={defaultArrangement()} catalog={[]} onOpen={() => {}} onHide={() => {}} onShow={() => {}} onPin={() => {}} onUnpin={() => {}} onAsk={() => {}} />
    <div className="h-48 shrink-0"><AgentTranscript blocks={[progress]} busy={false} inlineWork /></div>
    <NeedsRollupCard card={{items: [{key: "question:example-old", sentence: "Example: an earlier question", yours: false}], more: 0}} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Example />);
