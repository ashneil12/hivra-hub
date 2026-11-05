import { useEffect, useRef, useState } from "react";
import {
  backupItems,
  applySettingsResult,
  backupsStatus,
  backupWhen,
  claimSettingsChange,
  createBackup,
  finishSettingsChange,
  listBackups,
  pickBackupFolder,
  restoreBackupAll,
  restoreBackupItem,
  restoredTitle,
  scheduleLabel,
  setBackupFolder,
  setBackupSchedule,
  type BackupInfo,
  type BackupItem,
  type BackupSchedule,
  type BackupsStatus,
} from "../model/backups";

const BTN =
  "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";
const PRIMARY =
  "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-50";

const CONFIRM = "This quits Hivra, puts this backup back, and keeps a copy of what is here now.";

export type BackupsFixture = {
  status: BackupsStatus;
  backups: BackupInfo[];
  items: Record<string, BackupItem[]>;
};

type Load = {
  status: BackupsStatus;
  backups: BackupInfo[];
  items: BackupItem[];
};

function kindLabel(kind: string): string {
  if (kind === "chat") return "Chat";
  if (kind === "mono") return "Mono";
  if (kind === "doc") return "Doc";
  if (kind === "task") return "Task";
  return kind;
}

/** Settings → Backups. `fixture` is the browser test's data; without it the page asks the app. */
export function BackupsPage({ fixture }: { fixture?: BackupsFixture }) {
  const [load, setLoad] = useState<Load | null>(
    fixture
      ? { status: fixture.status, backups: fixture.backups, items: fixture.items[fixture.backups[0]?.id ?? ""] ?? [] }
      : null,
  );
  const [selected, setSelected] = useState(fixture?.backups[0]?.id ?? "");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const settingsRef = useRef({ generation: 0, busy: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => {
    if (fixture) return;
    let live = true;
    backupsStatus()
      .then(async (status) => {
        const backups = await listBackups();
        if (!live) return;
        const id = backups[0]?.id ?? "";
        const items = id ? await backupItems(id) : [];
        if (!live) return;
        setLoad({ status, backups, items });
        setSelected(id);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setProblem(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [fixture]);

  async function choose(id: string) {
    setSelected(id);
    setRestored(null);
    setConfirmAll(false);
    if (!load) return;
    if (fixture) {
      setLoad({ ...load, items: fixture.items[id] ?? [] });
      return;
    }
    setBusy("items");
    try {
      const items = await backupItems(id);
      if (selectedRef.current !== id) return;
      setLoad((current) => (current ? { ...current, items } : current));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  function claimSettings(): number | null {
    const next = claimSettingsChange(settingsRef.current);
    if (!next) return null;
    settingsRef.current = next;
    return next.generation;
  }

  function releaseSettings(mine: number) {
    settingsRef.current = finishSettingsChange(settingsRef.current, mine);
    if (settingsRef.current.generation === mine) setBusy(null);
  }

  function paintSettings(mine: number, patch: Partial<BackupsStatus>) {
    setLoad((current) => {
      if (!current) return current;
      const applied = applySettingsResult(settingsRef.current, mine, current.status, patch);
      if (!applied) return current;
      settingsRef.current = applied.state;
      return { ...current, status: applied.status };
    });
  }

  async function reloadSettings(mine: number) {
    const status = await backupsStatus();
    paintSettings(mine, status);
  }

  async function changeSchedule(schedule: BackupSchedule) {
    if (!load) return;
    const mine = claimSettings();
    if (mine === null) return;
    setProblem(null);
    setBusy("schedule");
    try {
      if (!fixture) await setBackupSchedule(schedule);
      paintSettings(mine, { schedule });
    } catch (error) {
      try {
        if (!fixture) await reloadSettings(mine);
      } catch {
        // The schedule on screen stays what the last successful read said.
      }
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      releaseSettings(mine);
    }
  }

  async function chooseFolder() {
    if (!load || fixture) return;
    const mine = claimSettings();
    if (mine === null) return;
    setProblem(null);
    setBusy("folder");
    try {
      const folder = await pickBackupFolder();
      if (!folder) return;
      await setBackupFolder(folder);
      paintSettings(mine, { folder, folderIsDefault: false });
    } catch (error) {
      try {
        await reloadSettings(mine);
      } catch {
        // The folder on screen stays what the last successful read said.
      }
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      releaseSettings(mine);
    }
  }

  async function useDefaultFolder() {
    if (!load || fixture) return;
    const mine = claimSettings();
    if (mine === null) return;
    setBusy("folder");
    setProblem(null);
    try {
      await setBackupFolder(null);
      await reloadSettings(mine);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      releaseSettings(mine);
    }
  }

  async function backUpNow() {
    if (!load || fixture) return;
    setBusy("create");
    setProblem(null);
    try {
      await createBackup();
      const [status, backups] = await Promise.all([backupsStatus(), listBackups()]);
      const id = backups[0]?.id ?? "";
      const items = id ? await backupItems(id) : [];
      setLoad({ status, backups, items });
      setSelected(id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function restoreOne(item: BackupItem) {
    if (!load || !selected) return;
    setBusy("restore");
    setProblem(null);
    const asked = selected;
    try {
      const done = fixture
        ? { ...item, id: `${item.id}-restored`, title: restoredTitle(item.title) }
        : await restoreBackupItem(asked, item.kind, item.id);
      if (selectedRef.current !== asked) return;
      setRestored(done.title);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function restoreAll() {
    if (!load || !selected) return;
    setBusy("all");
    setProblem(null);
    try {
      if (!fixture) await restoreBackupAll(selected);
      setConfirmAll(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  if (!load) {
    return <p className="text-[13px] text-content/60">{problem ?? "Reading backups…"}</p>;
  }

  const { status, backups, items } = load;
  return (
    <div className="flex flex-col gap-6" data-backups-page="">
      {status.dev ? (
        <p className="text-[13px] text-content/60">This copy starts with backups off, and only writes inside its own folder.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-content/60">Schedule</span>
        <span className="text-[13px] text-content" data-backup-schedule="">
          {scheduleLabel(status.schedule)}
        </span>
        {(["off", "hourly", "daily"] as const).map((schedule) => (
          <button key={schedule} type="button" className={BTN} disabled={busy !== null} onClick={() => void changeSchedule(schedule)}>
            {scheduleLabel(schedule)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-content/80" title={status.folder}>
          {status.folderIsDefault ? "Default folder" : status.folder}
        </span>
        <button type="button" className={BTN} disabled={busy !== null || Boolean(fixture)} onClick={() => void chooseFolder()}>
          Choose folder
        </button>
        {status.folderIsDefault ? null : (
          <button type="button" className={BTN} disabled={busy !== null} onClick={() => void useDefaultFolder()}>
            Use the default folder
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[13px] text-content">{status.lastGood ? `Last good backup ${backupWhen(status.lastGood.createdAt)}` : "No backup yet."}</p>
        <button type="button" className={PRIMARY} disabled={busy !== null || Boolean(fixture)} onClick={() => void backUpNow()}>
          {busy === "create" ? "Backing up…" : "Back up now"}
        </button>
      </div>
      {backups.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {backups.map((backup) => (
              <button
                key={backup.id}
                type="button"
                className={BTN}
                aria-pressed={backup.id === selected}
                onClick={() => void choose(backup.id)}
              >
                {backupWhen(backup.createdAt)}
              </button>
            ))}
          </div>
          {items.length === 0 ? (
            <p className="text-[13px] text-content/60">Nothing in this backup to bring back.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {items.map((item) => (
                <li key={`${item.kind}:${item.id}`} className="flex items-center gap-2">
                  <span className="text-[13px] text-content/50">{kindLabel(item.kind)}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-content">{item.title}</span>
                  <button type="button" className={BTN} disabled={busy !== null} onClick={() => void restoreOne(item)}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
          {restored ? <p className="text-[13px] text-content">Restored as {restored}</p> : null}
          <div className="flex flex-col items-start gap-2">
            <button type="button" className={BTN} disabled={busy !== null || !selected} onClick={() => setConfirmAll(true)}>
              Restore everything
            </button>
            {confirmAll ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-[13px] text-content">{CONFIRM}</p>
                <button type="button" className={PRIMARY} disabled={busy !== null} onClick={() => void restoreAll()}>
                  Put this backup back
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}
      {problem ? <p className="text-[13px] text-red-400">{problem}</p> : null}
    </div>
  );
}
