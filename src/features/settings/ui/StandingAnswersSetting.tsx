// Hivra WP-156: standing answers stay off until this is on. A failed read does not turn them off.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playCue } from "../model/sounds";
import { StandingAnswersSwitch } from "../../crew/ui/StandingAnswers";

const READ_AGAIN = "Couldn't read this setting. Trying again.";
const SAVE_AGAIN = "Couldn't save this setting. Trying again.";

export function StandingAnswersSetting() {
  const [on, setOn] = useState(false);
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    void invoke("decisions_standing_enabled")
      .then((value) => {
        if (mine !== gen.current) return;
        if (typeof value !== "boolean") {
          setNote(READ_AGAIN);
          return;
        }
        setOn(value);
        setReady(true);
        setNote(null);
      })
      .catch(() => {
        if (mine !== gen.current) return;
        setNote(READ_AGAIN);
      });
  }, []);

  async function change(next: boolean) {
    if (!ready) return;
    const mine = ++gen.current;
    setNote(null);
    try {
      const value = await invoke("decisions_set_standing_enabled", { enabled: next });
      if (mine !== gen.current) return;
      if (typeof value !== "boolean") {
        setNote(SAVE_AGAIN);
        return;
      }
      setOn(value);
      playCue("switch");
    } catch {
      if (mine !== gen.current) return;
      setNote(SAVE_AGAIN);
    }
  }

  return <StandingAnswersSwitch on={on} disabled={!ready} note={note} onChange={(next) => void change(next)} />;
}
