// WP-131: the composer's dictation. The controller owns the draft update.
import { useEffect, useRef, useState } from "react";
import {
  createDictationController,
  idleDictation,
  type DictationController,
  type DictationPort,
  type DictationStorage,
  type DictationView,
  type Selection,
} from "../model/dictation";

/**
 * Writes the draft the way dictation changes it: only the differing span is replaced, through the field's own
 * editing command, so Undo takes back the dictated words and nothing else. It only does that while the field has
 * focus (the command edits the focused field). Otherwise, or if the command does not apply, the value is set.
 */
export function writeDraftKeepingUndo(el: HTMLTextAreaElement, next: string): void {
  const current = el.value;
  if (current === next) return;
  if (typeof document !== "undefined" && document.activeElement === el) {
    let start = 0;
    const limit = Math.min(current.length, next.length);
    while (start < limit && current.charCodeAt(start) === next.charCodeAt(start)) start += 1;
    let tailCurrent = current.length;
    let tailNext = next.length;
    while (
      tailCurrent > start &&
      tailNext > start &&
      current.charCodeAt(tailCurrent - 1) === next.charCodeAt(tailNext - 1)
    ) {
      tailCurrent -= 1;
      tailNext -= 1;
    }
    el.setSelectionRange(start, tailCurrent);
    let applied = false;
    try {
      applied = document.execCommand("insertText", false, next.slice(start, tailNext));
    } catch {
      applied = false;
    }
    if (applied && el.value === next) return;
  }
  el.value = next;
}

function browserStorage(): DictationStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function useDictation(input: {
  port: DictationPort;
  enabled?: boolean;
  getText: () => string;
  getSelection: () => Selection;
  write: (text: string, cursor: number) => void;
}) {
  const inputRef = useRef(input);
  inputRef.current = input;
  const [view, setView] = useState<DictationView>(() => idleDictation(""));
  const [supported, setSupported] = useState(false);
  const controllerRef = useRef<DictationController | null>(null);
  const enabled = input.enabled !== false;

  useEffect(() => {
    const controller = createDictationController({
      port: input.port,
      getText: () => inputRef.current.getText(),
      getSelection: () => inputRef.current.getSelection(),
      write: (text, cursor) => inputRef.current.write(text, cursor),
      storage: browserStorage(),
      onChange: setView,
    });
    controllerRef.current = controller;
    let dead = false;
    void input.port.support().then((result) => {
      if (!dead) setSupported(result.available === true);
    });
    return () => {
      dead = true;
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [input.port]);

  useEffect(() => {
    if (!enabled) controllerRef.current?.seal();
  }, [enabled]);

  return {
    phase: view.phase,
    provisional: view.provisional,
    note: view.note,
    supported,
    ask: () => {
      if (supported) controllerRef.current?.ask();
    },
    accept: () => controllerRef.current?.accept(),
    cancel: () => controllerRef.current?.cancel(),
    decline: () => controllerRef.current?.decline(),
    stop: () => controllerRef.current?.stop(),
    seal: () => controllerRef.current?.seal(),
    onTyped: (text: string) => controllerRef.current?.onTyped(text),
  };
}
