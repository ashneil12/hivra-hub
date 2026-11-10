// The chat-move notice (WP-177): the marker on a chat that is now on a host, and the refusal with its reason. The
// recap button only appears when the target cannot resume, and it starts the existing recap into a new chat.

import type { MoveRefusal } from "../model/teleport";
import { teleportMarker, teleportRefusalCopy } from "./teleportCopy";

export type TeleportNoticeProps =
  | { kind: "on-host"; host: string; time: string }
  | { kind: "refused"; refusal: Pick<MoveRefusal, "reason" | "message" | "recapOffered">; onRecap?: () => void };

export function TeleportNotice(props: TeleportNoticeProps) {
  if (props.kind === "on-host") {
    return (
      <p role="status" className="teleport-marker" style={{ margin: "8px 0", fontSize: 13 }}>
        {teleportMarker(props.host, props.time)}
      </p>
    );
  }
  const copy = teleportRefusalCopy(props.refusal);
  return (
    <section role="status" aria-label="Chat move" className="teleport-refusal" style={{ margin: "8px 0", fontSize: 13 }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>{copy.title}</h3>
      <p style={{ margin: 0 }}>{copy.body}</p>
      {copy.recap && (
        <button type="button" onClick={props.onRecap} style={{ marginTop: 6 }}>
          {copy.recapLabel}
        </button>
      )}
    </section>
  );
}
