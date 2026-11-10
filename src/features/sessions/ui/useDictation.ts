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
    decline: () => controllerRef.current?.decline(),
    stop: () => controllerRef.current?.stop(),
    seal: () => controllerRef.current?.seal(),
    onTyped: (text: string) => controllerRef.current?.onTyped(text),
  };
}
