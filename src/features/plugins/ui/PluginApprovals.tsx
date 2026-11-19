import { useEffect, useRef, useState } from "react";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { pluginInboxCards, type PluginInboxCard } from "../model/pluginInbox";
import {
  approvePlugin,
  declinePlugin,
  listPending,
  plainError,
  readPending,
} from "../model/pluginInstall";

type Props = {
  /** Bumps when a new install starts waiting, so this list reloads. */
  refresh?: number;
  onChanged?: () => void;
};

/** Installs waiting for a yes. Renders nothing when there are none, including when the list can't be read. */
export function PluginApprovals({ refresh = 0, onChanged }: Props) {
  const [cards, setCards] = useState<PluginInboxCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);

  function load() {
    const ticket = ++generation.current;
    return listPending()
      .then((value) => {
        if (!mounted.current || ticket !== generation.current) return;
        setCards(pluginInboxCards(readPending(value)));
        setError(null);
      })
      .catch((caught) => {
        if (!mounted.current || ticket !== generation.current) return;
        setCards([]);
        setError(plainError(caught));
      });
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  async function answer(id: string, allow: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (allow) await approvePlugin(id);
      else await declinePlugin(id);
      await load();
      if (mounted.current) onChanged?.();
    } catch (caught) {
      if (mounted.current) setError(plainError(caught));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (cards.length === 0 && !error) return null;
  return (
    <div className="flex flex-col gap-2 px-3 py-2" aria-label="Plugin installs waiting">
      {error ? <p className="text-[12px] text-red-400">{error}</p> : null}
      {cards.map((card) => (
        <article key={card.id} className="rounded-md border border-stroke px-3 py-2" data-request={card.id}>
          <h3 className="text-[13px] text-content">{card.title}</h3>
          <p className="mt-1 text-[12px] text-content/70">{card.body}</p>
          {card.scanLine ? (
            <section className="mt-2 rounded border border-stroke px-2 py-1" aria-label="Install check">
              <p className="text-[12px] text-content/70">{card.scanLine}</p>
              {card.findings.length ? (
                <ul className="mt-1 list-disc pl-4 text-[12px] text-content/70">
                  {card.findings.map((found, index) => (
                    <li key={`${index}-${found.path}`}>
                      {found.path ? `${found.path}: ` : ""}
                      {found.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
          <div className="mt-2 flex gap-2">
            <SecondaryButton disabled={busy} onClick={() => void answer(card.id, true)}>
              Allow
            </SecondaryButton>
            <SecondaryButton disabled={busy} onClick={() => void answer(card.id, false)}>
              Don't install
            </SecondaryButton>
          </div>
        </article>
      ))}
    </div>
  );
}
