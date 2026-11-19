// The chat-move notice (WP-177): the marker on a chat that is now on a host, and the refusal with its reason. The
// recap button only appears when the target cannot resume, and it starts the existing recap into a new chat.

import type { MoveRefusal } from "../model/teleport";
import { teleportRefusalCopy } from "./teleportCopy";
import { copyForMoved } from "../model/teleportState";

export type TeleportNoticeProps =
  | { kind: "on-host"; host: string; time: string }
  | { kind: "refused"; refusal: Pick<MoveRefusal, "reason" | "message" | "recapOffered">; onRecap?: () => void };

export function TeleportNotice(props: TeleportNoticeProps) {
  if (props.kind === "on-host") {
    return (
      <p role="status" className="teleport-marker" style={{ margin: "8px 0", fontSize: 13 }}>
        {copyForMoved(props.host, props.time)}
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

/** The band at the top of a moved chat (WP-177): where it went, when, and what happens to the chat there. */
export function TeleportHeaderBand(props: { host: string; time: string }) {
  return (
    <div
      data-testid="teleport-header-band"
      role="status"
      className="teleport-header-band"
      style={{ padding: "8px 12px", borderBottom: "1px solid currentColor", fontSize: 13 }}
    >
      {copyForMoved(props.host, props.time)}
    </div>
  );
}

/** What the composer shows when the person tries to send into a moved chat. */
export function TeleportSendRefusal(props: { reason: string }) {
  return (
    <p data-testid="teleport-send-refusal" role="alert" style={{ margin: "6px 0", fontSize: 13 }}>
      {props.reason}
    </p>
  );
}
