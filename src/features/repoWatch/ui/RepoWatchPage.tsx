import { useEffect, useRef, useState } from "react";
import { SwitchRow } from "../../monos/ui/monoPanelParts";
import { importPinText, type PinDocument, type RepoPin } from "../model/pins";
import { emptyPins, loadPins, PinIoError, savePins, textFromFolder, type PinIo } from "../model/pinStore";

export type RepoWatchPageProps = {
  projectRoot: string;
  io: PinIo;
  pickFile: () => Promise<string | null>;
  pickFolder: () => Promise<string | null>;
  readPicked: (path: string) => Promise<string>;
};

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof PinIoError) return error.message;
  return fallback;
}

function reportLine(added: number, updated: number, skipped: string[]): string {
  const parts: string[] = [];
  if (added) parts.push(added === 1 ? "Added 1 repository." : `Added ${added} repositories.`);
  if (updated) parts.push(updated === 1 ? "Updated 1 repository." : `Updated ${updated} repositories.`);
  const extra = skipped.slice(0, 3);
  parts.push(...extra);
  if (skipped.length > extra.length) parts.push(`${skipped.length - extra.length} more were left out.`);
  return parts.join(" ") || "Nothing new was in that file.";
}

function PinLine({ pin }: { pin: RepoPin }) {
  return (
    <li className="flex flex-col gap-0.5 border-b border-stroke py-2">
      <a href={pin.url} rel="noreferrer" className="text-[13px] text-content">
        {pin.url.replace("https://github.com/", "")}
      </a>
      <span className="text-[12px] text-content/60">
        {pin.licence || "Licence not set"}, {pin.pinSha || "No pin"}
      </span>
      {pin.notes ? <span className="text-[12px] text-content/80">{pin.notes}</span> : null}
    </li>
  );
}

/**
 * Settings → Repo watch (WP-166). The list starts empty. Import is the opt-in
 * that writes `.hivra/repo-pins.json` in the project.
 */
export function RepoWatchPage({ projectRoot, io, pickFile, pickFolder, readPicked }: RepoWatchPageProps) {
  const [doc, setDoc] = useState<PinDocument>(emptyPins());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const generation = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!projectRoot.trim()) return;
    const mine = ++generation.current;
    let cancelled = false;
    setReady(false);
    void loadPins(io, projectRoot)
      .then((next) => {
        if (cancelled || mine !== generation.current) return;
        setDoc(next);
        setReady(true);
        setMessage("");
      })
      .catch((error: unknown) => {
        if (cancelled || mine !== generation.current) return;
        setMessage(messageFrom(error, "Could not read the pin list."));
      });
    return () => {
      cancelled = true;
    };
  }, [io, projectRoot]);

  async function importText(text: string) {
    const mine = ++generation.current;
    const signal = { aborted: false };
    let line = "";
    const saved = await savePins(
      io,
      projectRoot,
      (current) => {
        const report = importPinText(current, text);
        line = reportLine(report.added, report.updated, report.skipped);
        return report.document;
      },
      signal,
    );
    if (mine !== generation.current) return;
    setDoc(saved);
    setMessage(line);
  }

  async function onEnqueue(next: boolean) {
    if (busyRef.current || !projectRoot.trim()) return;
    busyRef.current = true;
    setBusy(true);
    const mine = ++generation.current;
    setDoc((current) => ({ ...current, enqueueDrafts: next }));
    try {
      const saved = await savePins(
        io,
        projectRoot,
        (current) => ({ pins: current.pins, enqueueDrafts: next }),
        { aborted: false },
      );
      if (mine !== generation.current) return;
      setDoc(saved);
      setMessage("");
    } catch (error) {
      if (mine !== generation.current) return;
      setDoc((current) => ({ ...current, enqueueDrafts: !next }));
      setMessage(messageFrom(error, "Could not save the pin list."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function onImportFile() {
    if (busyRef.current || !projectRoot.trim()) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const path = await pickFile();
      if (path === null) return;
      const text = await readPicked(path);
      await importText(text);
    } catch (error) {
      setMessage(messageFrom(error, "Could not read that file."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function onImportFolder() {
    if (busyRef.current || !projectRoot.trim()) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const folder = await pickFolder();
      if (folder === null) return;
      const found = await textFromFolder(folder, readPicked);
      await importText(found.text);
    } catch (error) {
      setMessage(messageFrom(error, "Could not read that folder."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (!projectRoot.trim()) {
    return (
      <section aria-label="Repo watch">
        <p className="text-[13px] text-content/80">Open a project first.</p>
      </section>
    );
  }

  return (
    <section aria-label="Repo watch" className="flex max-w-xl flex-col gap-3">
      <p className="text-[13px] text-content/70">
        Pinned upstream repositories for this project. The list starts empty and is saved only after you import.
      </p>
      <SwitchRow
        label="Queue draft upgrades"
        description="Off until you turn it on. A clear update with an MIT, Apache-2.0 or MPL-2.0 licence is saved as a draft. Nothing starts."
        on={doc.enqueueDrafts}
        disabled={!ready || busy}
        onChange={(next) => void onEnqueue(next)}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md border border-stroke px-3 py-1 text-[13px]"
          disabled={busy}
          onClick={() => void onImportFile()}
        >
          Import a file
        </button>
        <button
          type="button"
          className="rounded-md border border-stroke px-3 py-1 text-[13px]"
          disabled={busy}
          onClick={() => void onImportFolder()}
        >
          Import a folder
        </button>
      </div>
      {message ? <p className="text-[13px] text-content/80">{message}</p> : null}
      {doc.pins.length === 0 ? (
        <p className="text-[13px] text-content/60">No repositories are pinned yet.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {doc.pins.map((pin) => (
            <PinLine key={pin.url} pin={pin} />
          ))}
        </ul>
      )}
    </section>
  );
}
