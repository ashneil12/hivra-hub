import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { SparseCheckout } from "./SparseCheckout";

type SparseView = {
  enabled?: boolean;
  readable?: boolean;
};

const UNREADABLE = "The saved setting can't be read, so sparse checkout stays off.";

/**
 * WP-118: this project's sparse checkout switch. A reply for a project the person
 * already left is dropped. The switch paints off, and stays off when nothing is saved.
 */
export function SparseCheckoutSection({ cwd }: { cwd: string }) {
  const [enabled, setEnabled] = useState(false);
  const [note, setNote] = useState<string>();
  const generation = useRef(0);

  useEffect(() => {
    if (!cwd) return undefined;
    const mine = ++generation.current;
    setEnabled(false);
    setNote(undefined);
    let live = true;
    invoke<SparseView | undefined>("sparse_checkout_settings", { cwd }).then(
      (next) => {
        if (!live || mine !== generation.current) return;
        if (!next || typeof next.enabled !== "boolean") return;
        setEnabled(next.enabled);
        if (next.readable === false) setNote(UNREADABLE);
      },
      () => {
        if (live && mine === generation.current) setNote(UNREADABLE);
      },
    );
    return () => {
      live = false;
    };
  }, [cwd]);

  if (!cwd) return null;
  return (
    <SparseCheckout
      enabled={enabled}
      note={note}
      onChange={(next) => {
        const mine = generation.current;
        const previous = enabled;
        setEnabled(next);
        setNote(undefined);
        void invoke<SparseView | undefined>("sparse_checkout_set", {
          cwd,
          enabled: next,
          previous,
        }).then(
          (saved) => {
            if (mine !== generation.current) return;
            if (!saved || typeof saved.enabled !== "boolean") {
              setEnabled(previous);
              return;
            }
            setEnabled(saved.enabled);
            if (saved.readable === false) setNote(UNREADABLE);
          },
          (reason) => {
            if (mine !== generation.current) return;
            setEnabled(previous);
            setNote(typeof reason === "string" ? reason : "This setting could not be saved. Try again.");
          },
        );
      }}
    />
  );
}
