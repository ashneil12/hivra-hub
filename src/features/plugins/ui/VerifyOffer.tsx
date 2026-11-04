// WP-42. Offer Verify for this project. Listing it does not install it. Install still goes through plugins_install.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { installOutcome } from "../model/discover";
import { offerSentence, offerVisible, readDecline, readOffer, type VerifyOffer as Offer } from "../model/verifyOffer";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";
const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-50";

export function VerifyOffer({ projectFolder }: { projectFolder: string }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [holding, setHolding] = useState(false);
  const live = useRef<object | null>(null);

  useEffect(() => {
    const folder = projectFolder.trim();
    setHolding(false);
    setBusy(false);
    if (!folder) {
      live.current = {};
      setOffer(null);
      setNote(null);
      return;
    }
    const token = {};
    live.current = token;
    let gone = false;
    invoke("plugins_verify_offer", { folder })
      .then((payload) => {
        if (gone || live.current !== token) return;
        setOffer(readOffer(payload));
        setNote(null);
      })
      .catch(() => {
        if (gone || live.current !== token) return;
        setOffer(null);
      });
    return () => {
      gone = true;
    };
  }, [projectFolder]);

  if (!offerVisible(offer) || !offer) return null;
  const current = offer;

  async function install() {
    if (!current.source || busy || holding) return;
    const token = live.current;
    setBusy(true);
    try {
      const outcome = installOutcome(
        await invoke("plugins_install", { source: current.source, requestedBy: { kind: "person" } }),
      );
      if (live.current !== token) return;
      setNote(outcome.message);
      if (outcome.message.startsWith("Installed ")) setOffer({ ...current, installed: true });
      if (outcome.message.startsWith("Waiting for your OK in the Inbox")) setHolding(true);
    } catch {
      if (live.current !== token) return;
      setNote("It wasn't installed. Try again.");
    } finally {
      if (live.current === token) setBusy(false);
    }
  }

  async function decline() {
    if (busy) return;
    const token = live.current;
    const folder = projectFolder.trim();
    setBusy(true);
    try {
      const result = readDecline(
        await invoke("plugins_verify_decline", { folder, revision: current.revision }),
      );
      if (live.current !== token) return;
      if (!result) {
        setNote("It wasn't saved. Try again.");
        return;
      }
      setOffer(result.offer);
      setNote(result.applied ? null : "Another window changed this. Try again.");
    } catch {
      if (live.current !== token) return;
      setNote("It wasn't saved. Try again.");
    } finally {
      if (live.current === token) setBusy(false);
    }
  }

  return (
    <div data-verify-offer className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-content/10 px-3 py-2">
      <p data-verify-sentence className="min-w-0 flex-1 text-[13px] text-content/85">
        {offerSentence(current)}
      </p>
      <p data-verify-note className="w-full text-xs text-content/55">
        Verify can prove UI changes. Install needs your OK.
      </p>
      {note ? (
        <p data-verify-status className="w-full text-xs text-content/70">
          {note}
        </p>
      ) : null}
      <button type="button" className={PRIMARY} disabled={busy || holding} onClick={() => void install()}>
        Install
      </button>
      <button type="button" className={BTN} disabled={busy} onClick={() => void decline()}>
        Not now
      </button>
    </div>
  );
}
