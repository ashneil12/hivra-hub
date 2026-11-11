// Hivra WP-156: load standing answers for the Inbox. A failed read is not a final off.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DECISIONS_CHANGED } from "../../firstmate/model/steering";
import { StandingAnswers, type RetireResult, type StandingAnswer } from "./StandingAnswers";

function asRows(value: unknown): StandingAnswer[] {
  if (!Array.isArray(value)) return [];
  const out: StandingAnswer[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const key = typeof row.decisionKey === "string" ? row.decisionKey.trim() : "";
    const standingId = typeof row.standingId === "string" ? row.standingId.trim() : "";
    if (!key || !standingId) continue;
    out.push({
      project: typeof row.project === "string" ? row.project : "",
      key,
      standingId,
      question: typeof row.question === "string" ? row.question : "",
      answer: typeof row.answer === "string" ? row.answer : "",
      uses: typeof row.uses === "number" && Number.isFinite(row.uses) ? row.uses : 0,
      standing: row.standing === true,
    });
  }
  return out;
}

function asRetire(value: unknown): RetireResult | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.applied !== "boolean") return null;
  const relied: string[] = [];
  if (Array.isArray(row.relied)) {
    for (const item of row.relied) {
      if (!item || typeof item !== "object") continue;
      const id = (item as Record<string, unknown>).taskId;
      if (typeof id === "string" && id.trim()) relied.push(id.trim());
    }
  }
  return { applied: row.applied, gone: row.decision == null, relied };
}

export function StandingAnswersPanel({ project }: { project: string }) {
  const [enabled, setEnabled] = useState(false);
  const [rows, setRows] = useState<StandingAnswer[]>([]);
  const [stale, setStale] = useState(false);
  const gen = useRef(0);
  const folder = project.trim();

  const load = useCallback(async () => {
    const mine = ++gen.current;
    if (!folder) {
      setEnabled(false);
      setRows([]);
      setStale(false);
      return;
    }
    try {
      const on = await invoke("decisions_standing_enabled");
      if (mine !== gen.current) return;
      if (on !== true) {
        setEnabled(false);
        setRows([]);
        setStale(false);
        return;
      }
      const listed = await invoke("decisions_reuse_list", { project: folder });
      if (mine !== gen.current) return;
      setEnabled(true);
      setRows(asRows(listed));
      setStale(false);
    } catch {
      if (mine !== gen.current) return;
      setStale(true);
    }
  }, [folder]);

  useEffect(() => {
    let dead = false;
    void load();
    const timer = window.setInterval(() => {
      if (!dead) void load();
    }, 60_000);
    let unlisten: (() => void) | undefined;
    void listen(DECISIONS_CHANGED, () => {
      if (!dead) void load();
    })
      .then((off) => {
        if (dead) off();
        else unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      dead = true;
      gen.current += 1;
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [load]);

  async function onRetire(row: StandingAnswer, reason: string): Promise<RetireResult> {
    const value = asRetire(
      await invoke("decisions_retire", { project: row.project || folder, key: row.key, reason }),
    );
    if (!value) throw new Error("The retire result was not a decision.");
    void load();
    return value;
  }

  async function onReuse(row: StandingAnswer, standing: boolean): Promise<boolean> {
    const value = await invoke("decisions_set_standing", {
      project: row.project || folder,
      key: row.key,
      standing,
    });
    const got = value && typeof value === "object" ? (value as Record<string, unknown>).standing : undefined;
    if (got !== standing) return false;
    void load();
    return true;
  }

  if (!folder) return null;
  return <StandingAnswers enabled={enabled} rows={rows} stale={stale} onRetire={onRetire} onReuse={onReuse} />;
}
