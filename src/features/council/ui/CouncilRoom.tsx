// WP-23: a room's council. The group view only opens this; the run, the tally and the brief stay in the council modules.
import { useEffect, useRef, useState } from "react";
import { getChat, saveCouncil, useHubChatsVersion } from "../../hub/model/hubChats";
import { availableCouncilEngines, councilModelInUse, installCouncilModel, openCouncilSeat, postCouncilBrief } from "../model/host";
import { bundledPersonas, combinePersonas } from "../model/personas";
import { blankProposal, type CouncilRecord } from "../model/record";
import { CouncilView } from "./CouncilView";

export function CouncilRoom({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  useHubChatsVersion();
  const [, setModelTick] = useState(0);
  useEffect(() => {
    installCouncilModel();
    setModelTick((n) => n + 1);
  }, []);
  const chat = getChat(chatId);
  const expected = useRef(chat?.council?.revision ?? 0);
  if (!chat) return null;
  const record = chat.council ?? blankProposal("");

  function publish(next: CouncilRecord): boolean {
    const ok = saveCouncil(chatId, next, expected.current);
    if (!ok) return false;
    expected.current += 1;
    return true;
  }

  return (
    <CouncilView
      roomId={chat.id}
      record={record}
      engines={availableCouncilEngines()}
      personas={combinePersonas(bundledPersonas(), [])}
      model={councilModelInUse()}
      onChange={publish}
      onOpenSeat={openCouncilSeat}
      onDelegate={() => {
        const current = getChat(chatId)?.council;
        if (current) postCouncilBrief(chatId, current);
      }}
      onClose={onClose}
    />
  );
}
