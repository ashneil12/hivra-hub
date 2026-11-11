// Hivra WP-81: the check on the crew's task. One question when it needs a person. A failed load keeps the last cards.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { isGuardRefusal } from "../../commit-guard/model/refusal";
import { OpenInSourceControlLink } from "../../commit-guard/ui/OpenInSourceControlLink";

const TRY_AGAIN = "That didn't go through. Try again.";
const ANSWERS = ["Approve", "Fix", "Skip"] as const;

type Card = {
  id: string;
  line: string;
  finding: string | null;
  decisionKey: string | null;
  prUrl: string | null;
  state: string;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function httpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function asCard(value: unknown): Card | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  const line = typeof row.line === "string" ? row.line : null;
  const state = text(row.state);
  if (!id || line === null || !state) return null;
  return {
    id,
    line,
    finding: text(row.finding),
    decisionKey: text(row.decisionKey),
    prUrl: httpsUrl(text(row.prUrl)),
    state,
  };
}

function parseCards(value: unknown): Card[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((row) => {
    const card = asCard(row);
    return card ? [card] : [];
  });
}

export function GateCards({ project }: { project: string }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    setSending(null);
    const folder = project.trim();
    if (!folder) {
      setCards([]);
      setTrouble(null);
      return;
    }
    void invoke("gate_cards", { project: folder })
      .then((got) => {
        if (mine !== gen.current) return;
        const next = parseCards(got);
        if (!next) {
          setTrouble(TRY_AGAIN);
          return;
        }
        setCards(next);
        setTrouble(null);
      })
      .catch(() => {
        if (mine !== gen.current) return;
        setTrouble(TRY_AGAIN);
      });
  }, [project]);

  async function choose(key: string, answer: string) {
    const mine = gen.current;
    setSending(key);
    try {
      await invoke("gate_respond", { decisionKey: key, answer, project: project.trim() });
    } catch {
      if (mine !== gen.current) return;
      setSending(null);
      setTrouble(TRY_AGAIN);
      return;
    }
    if (mine !== gen.current) return;
    setSending(null);
    const reload = ++gen.current;
    const folder = project.trim();
    if (!folder) return;
    try {
      const next = parseCards(await invoke("gate_cards", { project: folder }));
      if (reload !== gen.current) return;
      if (!next) {
        setTrouble(TRY_AGAIN);
        return;
      }
      setCards(next);
      setTrouble(null);
    } catch {
      if (reload !== gen.current) return;
      setTrouble(TRY_AGAIN);
    }
  }

  if (cards.length === 0 && !trouble) return null;

  return (
    <section aria-label="Checks" className="border-b border-stroke">
      {trouble ? <p className="px-3 pt-2 text-[12px] text-content/60">{trouble}</p> : null}
      <ul>
        {cards.map((card) => {
          const parked = card.state === "parked" && card.decisionKey !== null;
          const finding = card.finding && card.finding !== card.line ? card.finding : null;
          return (
            <li key={card.id} className="border-b border-stroke px-3 py-2 last:border-b-0">
              <p className="text-[13px] text-content">{card.line}</p>
              {finding ? <p className="mt-0.5 text-[12px] text-content/70">{finding}</p> : null}
              {finding && isGuardRefusal(finding) ? <OpenInSourceControlLink message={finding} /> : null}
              {card.prUrl ? (
                <button
                  type="button"
                  className="mt-0.5 block truncate text-left text-[12px] text-content/70"
                  onClick={() => {
                    const url = card.prUrl;
                    if (!url) return;
                    void openUrl(url).catch(() => setTrouble(TRY_AGAIN));
                  }}
                >
                  {card.prUrl}
                </button>
              ) : null}
              {parked ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {ANSWERS.map((answer) => (
                    <SecondaryButton
                      key={answer}
                      disabled={sending !== null}
                      onClick={() => void choose(card.decisionKey as string, answer)}
                    >
                      {answer}
                    </SecondaryButton>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
