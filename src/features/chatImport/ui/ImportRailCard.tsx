// The sidebar's small card while the "bring my chats over" setup is under way, beside the update card. When a part
// needs the person (choose what comes in, go through the suggested rules) a click brings them back into the setup.

import { useSyncExternalStore } from "react";
import { Loader } from "../../../shared/ui/icons";
import { useLearnRun } from "../../memory/ui/learnHost";
import { chatImportRun } from "../model/live";
import { setupState, subscribeSetup } from "../model/setupStage";
import { useImportState } from "./ChatImportPanel";
import { OPEN_IMPORT_SETUP_EVENT, railCard } from "./importRail";

export function ImportRailCard() {
  const setup = useSyncExternalStore(subscribeSetup, setupState, setupState);
  const state = useImportState(chatImportRun());
  const learn = useLearnRun();
  const card = railCard(setup, state, learn);
  if (!card) return null;
  const body = (
    <>
      <span className="mt-0.5 grid size-[18px] shrink-0 place-items-center">
        {card.busy ? <Loader className="size-3.5 animate-spin text-content/70" strokeWidth={1.75} /> : <span className="size-2 rounded-full bg-content/70" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium leading-tight text-content">{card.title}</span>
        <span className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-content/60">{card.line}</span>
      </span>
    </>
  );
  return (
    <section role="status" className="overflow-hidden rounded-lg bg-content/12" data-import-rail-card={card.key}>
      {card.open ? (
        <button
          type="button"
          data-import-rail-open={card.open}
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_IMPORT_SETUP_EVENT, { detail: { part: card.open } }))}
          className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          {body}
        </button>
      ) : (
        <div className="flex w-full items-start gap-2 px-2 py-2">{body}</div>
      )}
    </section>
  );
}
