// The quiet line a message sent beside the one chat leaves in it (asks/model/besideChat.ts): who it went to and what he
// said, with the way back to that chat beside this one. Not a message of his in this chat, so it isn't a bubble.
import { MessageSquare } from "../../../shared/ui/icons";
import { openFromHome } from "../../home/model/opener";
import { openBesideChief, type BesideMessage } from "../model/besideChat";

export function BesideMessageLine({ message, embedded = false }: { message: BesideMessage; embedded?: boolean }) {
  return (
    <div className={`${embedded ? "" : "px-4"} py-1 font-sans`}>
      <p data-beside-message={message.chatId} className="group flex max-w-[720px] items-start gap-2 text-[12px] leading-5 text-content/60">
        <MessageSquare aria-hidden className="mt-1 size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="min-w-0 flex-1">
          You messaged <span className="text-content/80">{message.to}</span>: <span className="text-content/80">“{message.text}”</span>
          <span className="text-content/60"> · the Chief of Staff knows.</span>
        </span>
        <button
          type="button"
          aria-label={`Open ${message.to}'s chat beside this one`}
          onClick={() => {
            if (!openBesideChief(message.chatId)) openFromHome({ kind: "chat", id: message.chatId, projectId: "" });
          }}
          className="shrink-0 rounded-md px-1.5 text-[12px] text-content/70 opacity-0 hover:bg-content/8 hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
        >
          Open
        </button>
      </p>
    </div>
  );
}
