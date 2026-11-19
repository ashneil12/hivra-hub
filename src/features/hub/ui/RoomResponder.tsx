import { monoLook, type Mono } from "../../monos/model/mono";
import { setRoomLead, setRoomResponder } from "../model/hubChats";
import { quickModel } from "../model/roomDecider";
import { RESPONDER_LABELS, RESPONDER_MODES, responderOf } from "../model/roomModes";
import { hostOf } from "../model/roomTurns";
import type { GroupChat } from "../model/types";

/**
 * WP-22: who answers in a team's chat (its responder mode) and who leads it. Auto names the quick model it asks, or
 * says the lead answers until one is set up. Dropwave (Ash, 11 Nov): shown in Settings, Teams, under each team; the
 * chat itself only has the defaults at work.
 */
export function RoomResponder({ chat, members }: { chat: GroupChat; members: Mono[] }) {
  const mode = responderOf(chat);
  const lead = hostOf(members.map((m) => ({ id: m.id, name: monoLook(m).name })), chat.leadId);
  const model = mode === "auto" ? quickModel() : undefined;
  const select = "h-7 w-full rounded-md border border-content/15 bg-transparent px-1.5 text-[13px] text-content";
  return (
    <div className="flex flex-col gap-1.5" data-hub-room-settings>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-0.5 text-xs leading-5 text-content/60">
          Who answers
          <select className={select} value={mode} onChange={(e) => setRoomResponder(chat.id, e.target.value as typeof mode)} data-hub-room-responder>
            {RESPONDER_MODES.map((m) => (
              <option key={m} value={m}>
                {RESPONDER_LABELS[m].label}
              </option>
            ))}
          </select>
        </label>
        {members.length > 1 ? (
          <label className="flex flex-col gap-0.5 text-xs leading-5 text-content/60">
            Lead
            <select className={select} value={lead?.id ?? ""} onChange={(e) => setRoomLead(chat.id, e.target.value || undefined)} data-hub-room-lead>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {monoLook(m).name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <p className="text-[12px] leading-4 text-content/55" data-hub-room-responder-hint>
        {RESPONDER_LABELS[mode].hint}
        {mode === "auto" ? (model ? ` It asks ${model.name}.` : " Add a model in Settings, Other models; until then the lead answers.") : ""}
      </p>
    </div>
  );
}
