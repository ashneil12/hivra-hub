import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { PluginApprovals } from "./PluginApprovals";
import {
  installedRows,
  isWaiting,
  listPlugins,
  pinField,
  plainError,
  readRegistry,
  removePlugin,
  rollbackPlugin,
  sourceLine,
  updatePayload,
  updatePlugin,
  type InstalledPlugin,
} from "../model/pluginInstall";

/** The Installed list: update to an exact version, roll back one step, or remove. */
export function InstalledPlugins() {
  const [rows, setRows] = useState<InstalledPlugin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const mounted = useRef(true);

  const reload = useCallback(() => {
    const ticket = ++generation.current;
    return listPlugins()
      .then((value) => {
        if (!mounted.current || ticket !== generation.current) return;
        setRows(installedRows(readRegistry(value)));
        setError(null);
      })
      .catch((caught) => {
        if (!mounted.current || ticket !== generation.current) return;
        setError(plainError(caught));
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  async function run(name: string, action: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (!mounted.current) return;
      if (isWaiting(result)) {
        setNotice("Waiting for your OK.");
        setRefresh((current) => current + 1);
      }
      setEditing(null);
      setPin("");
      await reload();
    } catch (caught) {
      if (mounted.current) setError(plainError(caught));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  function submitUpdate(event: FormEvent, row: InstalledPlugin) {
    event.preventDefault();
    const field = pinField(row.source?.kind);
    if (!pin.trim()) {
      setError(field.empty);
      return;
    }
    void run(row.name, () => updatePlugin(row.name, updatePayload(row.source, pin)));
  }

  return (
    <div className="flex flex-col gap-3">
      <PluginApprovals refresh={refresh} onChanged={() => void reload()} />
      {error ? (
        <p className="text-[13px] text-red-400">{error}</p>
      ) : null}
      {notice ? <p className="text-[13px] text-content/70">{notice}</p> : null}
      {rows.length === 0 && !error ? (
        <p className="text-[13px] text-content/60">Nothing is installed.</p>
      ) : null}
      <ul aria-label="Installed plugins" className="flex flex-col gap-2">
        {rows.map((row) => {
          const field = pinField(row.source?.kind);
          const open = editing === row.name;
          return (
            <li
              key={row.name}
              data-plugin={row.name}
              data-version={row.version ?? ""}
              className="rounded-md border border-stroke px-3 py-2"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] text-content">{row.name}</span>
                <span className="text-[12px] text-content/60">{row.version || "Unknown version"}</span>
              </div>
              <p className="mt-0.5 text-[12px] text-content/50">{sourceLine(row.source)}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <SecondaryButton
                  disabled={busy !== null}
                  onClick={() => {
                    setEditing(open ? null : row.name);
                    setPin("");
                    setError(null);
                  }}
                >
                  Update
                </SecondaryButton>
                {row.previous ? (
                  <SecondaryButton
                    disabled={busy !== null}
                    onClick={() => void run(row.name, () => rollbackPlugin(row.name))}
                  >
                    Roll back
                  </SecondaryButton>
                ) : null}
                <SecondaryButton
                  danger
                  disabled={busy !== null}
                  onClick={() => void run(row.name, () => removePlugin(row.name))}
                >
                  Remove
                </SecondaryButton>
              </div>
              {open ? (
                <form className="mt-2 flex flex-col gap-2" onSubmit={(event) => submitUpdate(event, row)}>
                  <label className="flex flex-col gap-1 text-[12px] text-content/70">
                    {field.label}
                    <input
                      aria-label={field.label}
                      value={pin}
                      onChange={(event) => setPin(event.target.value)}
                      className="rounded-md border border-stroke bg-transparent px-2 py-1 text-[13px] text-content"
                    />
                  </label>
                  <div className="flex gap-2">
                    <SecondaryButton type="submit" disabled={busy !== null}>
                      Install this version
                    </SecondaryButton>
                    <SecondaryButton
                      disabled={busy !== null}
                      onClick={() => {
                        setEditing(null);
                        setPin("");
                      }}
                    >
                      Cancel
                    </SecondaryButton>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
