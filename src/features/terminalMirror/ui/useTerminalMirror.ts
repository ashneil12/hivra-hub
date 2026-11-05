// WP-85. Live terminal sessions for the chat list. A page without the app gets an empty list, not a throw.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TerminalSession } from "../../../../plugins/hivra-mirror/src/book.ts";
import { sessionsFromWire, terminalSessionId } from "../model/list";

export function useTerminalMirror() {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const gen = useRef(0);

  const refresh = useCallback(async (mine: number) => {
    try {
      const got = await invoke("terminal_mirror_list");
      if (mine !== gen.current) return;
      setSessions(sessionsFromWire(got));
    } catch {
      if (mine !== gen.current) return;
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    const mine = ++gen.current;
    let stop = () => {};
    let cancel = false;
    void listen("terminal-mirror://changed", () => {
      void refresh(mine);
    })
      .then((unlisten) => {
        if (cancel || mine !== gen.current) {
          unlisten();
          return;
        }
        stop = unlisten;
      })
      .catch(() => {
        // No event plugin: the list stays whatever the last read returned.
      });
    void refresh(mine);
    return () => {
      cancel = true;
      gen.current += 1;
      stop();
    };
  }, [refresh]);

  const openSession = useCallback((rowId: string) => {
    const id = terminalSessionId(rowId);
    if (!id) return false;
    setOpenId(id);
    setNote(null);
    return true;
  }, []);

  const close = useCallback(() => {
    setOpenId(null);
    setNote(null);
  }, []);

  const steer = useCallback(
    async (action: "reply" | "stop" | "permission", extra?: { text?: string; allow?: boolean }) => {
      if (!openId) return;
      const session = sessions.find((item) => item.id === openId);
      try {
        await invoke("terminal_mirror_steer", {
          id: openId,
          action,
          text: extra?.text,
          allow: extra?.allow,
          requestId: session?.pendingPermission?.requestId,
        });
        setNote(action === "reply" ? "A reply is waiting for the next turn." : null);
      } catch (error) {
        setNote(typeof error === "string" && error.trim() ? error : "That didn't go through. Try again.");
      }
    },
    [openId, sessions],
  );

  const attach = useCallback(
    async (taskId: string) => {
      if (!openId || !taskId.trim()) return;
      try {
        await invoke("terminal_mirror_attach", { sessionId: openId, taskId });
        setNote("Attached to the task.");
      } catch (error) {
        setNote(typeof error === "string" && error.trim() ? error : "That didn't go through. Try again.");
      }
    },
    [openId],
  );

  const session = sessions.find((item) => item.id === openId) ?? null;

  return {
    sessions,
    session,
    note,
    openSession,
    close,
    reply: (text: string) => void steer("reply", { text }),
    stop: () => void steer("stop"),
    allow: () => void steer("permission", { allow: true }),
    deny: () => void steer("permission", { allow: false }),
    attach,
  };
}
