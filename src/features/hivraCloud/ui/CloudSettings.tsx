// WP-61. Hivra Cloud in Settings. Off until the person turns it on. An empty address makes no network call.

import { useEffect, useRef, useState } from "react";
import { requestAddMachine } from "../model/addMachine";
import {
  ACCOUNT_NOTICE,
  asAccount,
  asStatus,
  CLOUD_OFF,
  cloudApi,
  CloudSaveConflict,
  type AccountView,
  type CloudApi,
  type CloudStatus,
} from "../model/cloud";
import { endpointProblem } from "../model/endpoint";
import { pairCode, readMachine, type CloudMachine } from "../model/machine";

const input =
  "w-full rounded-lg border border-content/15 bg-content/3 px-3 py-2 text-[13px] outline-none focus:border-content/35";
const button =
  "rounded-lg bg-selection px-3 py-2 text-[13px] font-medium hover:bg-selection-hover disabled:opacity-40";

function words(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "Hivra Cloud could not do that. Try again.";
}

export function CloudSettings({ api = cloudApi }: { api?: CloudApi }) {
  const [status, setStatus] = useState<CloudStatus>(CLOUD_OFF);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [signError, setSignError] = useState("");
  const [account, setAccount] = useState<AccountView | null>(null);
  const [accountPending, setAccountPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState("");
  const [machines, setMachines] = useState<CloudMachine[]>([]);
  const [handed, setHanded] = useState("");
  const alive = useRef(true);
  const epoch = useRef(0);
  const revision = useRef(0);
  const chain = useRef(Promise.resolve());
  const pairingLock = useRef(false);

  function apply(next: CloudStatus) {
    revision.current = next.revision;
    setStatus(next);
    setDraft(next.endpoint);
  }

  useEffect(() => {
    alive.current = true;
    const mine = epoch.current;
    void api
      .status()
      .then((value) => {
        if (!alive.current || mine !== epoch.current) return;
        apply(asStatus(value));
        setLoaded(true);
      })
      .catch(() => {
        if (!alive.current || mine !== epoch.current) return;
        apply(CLOUD_OFF);
        setLoaded(true);
        setFormError("Hivra Cloud settings could not be read. It stays off.");
      });
    return () => {
      alive.current = false;
    };
  }, [api]);

  useEffect(() => {
    if (!status.signedIn) {
      setAccount(null);
      setAccountPending(false);
      return;
    }
    const mine = epoch.current;
    let cancel = false;
    setAccountPending(true);
    void api
      .account()
      .then((value) => {
        if (cancel || !alive.current || mine !== epoch.current) return;
        const next = asAccount(value);
        setAccount(next);
        if (next.notice) setNotice(next.notice);
        if (next.noticeError) setFormError(next.noticeError);
      })
      .catch(() => {
        if (cancel || !alive.current || mine !== epoch.current) return;
        setAccount({ status: "unavailable", plan: null, machineLimit: null, notice: ACCOUNT_NOTICE, noticeError: null });
        setNotice(ACCOUNT_NOTICE);
      })
      .finally(() => {
        if (!cancel && alive.current && mine === epoch.current) setAccountPending(false);
      });
    return () => {
      cancel = true;
    };
  }, [api, status.signedIn]);

  function enqueue(job: () => Promise<void>): Promise<void> {
    const run = chain.current.then(job, job);
    chain.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function commit(enabled: boolean, endpoint: string) {
    const turningOff = status.enabled && !enabled;
    const addressChanged = endpoint.trim() !== status.endpoint.trim();
    const signingOut = turningOff || (status.signedIn && addressChanged);
    if (signingOut) epoch.current += 1;
    setSaving(true);
    setFormError("");
    try {
      await enqueue(async () => {
        try {
          let next = asStatus(await api.save(enabled, endpoint.trim(), revision.current));
          if (!alive.current) return;
          if (signingOut) {
            setMachines([]);
            setNotice(null);
            setHanded("");
            setSignError("");
            setPairError("");
            try {
              await api.signOut();
            } catch {
              // Sign-out only drops the in-memory token. The switch or the new address is already saved.
            }
            next = { ...next, signedIn: false };
          }
          if (!alive.current) return;
          apply(next);
        } catch (error) {
          if (!alive.current) return;
          if (error instanceof CloudSaveConflict) {
            try {
              const latest = asStatus(await api.status());
              if (alive.current) apply(latest);
            } catch {
              // Keep the address already on screen.
            }
            setFormError(error.message);
            return;
          }
          setFormError(words(error));
        }
      });
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  function turn() {
    if (!loaded || saving) return;
    const next = !status.enabled;
    const problem = endpointProblem(draft);
    if (next && problem) {
      setFormError(problem);
      return;
    }
    void commit(next, draft);
  }

  function blurAddress() {
    if (!loaded || saving) return;
    if (draft.trim() === status.endpoint.trim()) return;
    const problem = endpointProblem(draft);
    if (problem) {
      setFormError(problem);
      return;
    }
    void commit(status.enabled, draft);
  }

  async function signIn() {
    if (!loaded || status.state !== "ready" || signingIn) return;
    const mine = epoch.current;
    setSigningIn(true);
    setSignError("");
    try {
      const next = asStatus(await api.signIn());
      if (!alive.current || mine !== epoch.current) return;
      apply(next);
    } catch (error) {
      if (!alive.current || mine !== epoch.current) return;
      setSignError(words(error));
    } finally {
      if (alive.current && mine === epoch.current) setSigningIn(false);
    }
  }

  async function pair() {
    const checked = pairCode(code);
    if (!checked) {
      setPairError("That pairing code isn't valid. Copy it again from Hivra Cloud.");
      return;
    }
    if (pairingLock.current) return;
    pairingLock.current = true;
    const mine = epoch.current;
    setPairing(true);
    setPairError("");
    try {
      const machine = readMachine(await api.pair(checked));
      if (!alive.current || mine !== epoch.current) return;
      if (!machine) {
        setPairError("Hivra Cloud sent a machine this app couldn't use.");
        return;
      }
      setMachines((list) => [machine, ...list.filter((item) => item.id !== machine.id)]);
      setCode("");
    } catch (error) {
      if (!alive.current || mine !== epoch.current) return;
      setPairError(words(error));
    } finally {
      pairingLock.current = false;
      if (alive.current && mine === epoch.current) setPairing(false);
    }
  }

  function addMachine(machine: CloudMachine) {
    if (!machine.sshHost) return;
    requestAddMachine({ target: machine.sshHost, name: machine.label });
    setHanded(machine.id);
  }

  const showSignIn = loaded && status.enabled && status.state === "ready" && !status.signedIn;
  const showMachines = loaded && status.signedIn;

  return (
    <section id="setting-hivra-cloud" data-setting-id="hivra-cloud" className="flex flex-col gap-5">
      <div>
        <h2 className="text-[13px] font-semibold text-content">Hivra Cloud</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-content/45">
          A managed machine that stays on. Off until you turn it on. With it off, or with no address, nothing is contacted.
        </p>
      </div>
      <div className="flex items-center justify-between gap-6 rounded-xl border border-content/10 bg-content/3 px-4 py-3.5">
        <span className="text-[13px] text-content">Hivra Cloud</span>
        <button
          type="button"
          role="switch"
          aria-label="Hivra Cloud"
          aria-checked={status.enabled}
          disabled={!loaded || saving}
          onClick={turn}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
            status.enabled ? "bg-accent" : "bg-content/20"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${
              status.enabled ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
      <label className="flex flex-col gap-1.5 text-[12px] text-content/65">
        Address
        <input
          aria-label="Hivra Cloud address"
          className={input}
          value={draft}
          disabled={!loaded || saving}
          placeholder="https://"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            setFormError("");
          }}
          onBlur={blurAddress}
        />
      </label>
      {formError ? (
        <p role="status" className="text-[12px] leading-relaxed text-content/70">
          {formError}
        </p>
      ) : null}
      {loaded && status.enabled && status.state === "no_endpoint" ? (
        <p className="text-[12px] leading-relaxed text-content/45">Add an address before signing in.</p>
      ) : null}
      {loaded && status.state === "bad_endpoint" && status.message ? (
        <p role="status" className="text-[12px] leading-relaxed text-content/70">
          {status.message}
        </p>
      ) : null}
      {showSignIn ? (
        <div data-screen="sign-in" className="flex flex-col gap-3 rounded-xl border border-stroke p-5">
          <h3 className="text-[14px] font-medium">Sign in</h3>
          <p className="text-[12px] leading-relaxed text-content/45">
            Sign-in opens in your browser on this Mac. Hivra keeps working while you finish it.
          </p>
          {signingIn ? (
            <p className="text-[12px] text-content/60">Finish sign-in in the browser.</p>
          ) : null}
          {signError ? (
            <p role="status" className="text-[12px] text-content/70">
              {signError}
            </p>
          ) : null}
          <div>
            <button type="button" className={button} disabled={signingIn} onClick={() => void signIn()}>
              Sign in
            </button>
          </div>
        </div>
      ) : null}
      {showMachines ? (
        <div data-screen="machines" className="flex flex-col gap-4 rounded-xl border border-stroke p-5">
          <div>
            <h3 className="text-[14px] font-medium">Cloud machines</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-content/45">
              Pair with a code from Hivra Cloud. The code is single use. It is not a key. Nothing is added until you choose Add this machine.
            </p>
          </div>
          {accountPending ? <p className="text-[12px] text-content/45">Checking the account…</p> : null}
          {account?.plan ? <p className="text-[12px] text-content/60">Plan: {account.plan}</p> : null}
          {notice ? (
            <p role="alert" className="text-[12px] leading-relaxed text-content/70">
              {notice}
            </p>
          ) : null}
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void pair();
            }}
          >
            <label className="flex flex-col gap-1.5 text-[12px] text-content/65">
              Pairing code
              <input
                aria-label="Pairing code"
                className={input}
                value={code}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            {pairError ? (
              <p role="status" className="text-[12px] text-content/70">
                {pairError}
              </p>
            ) : null}
            <div>
              <button type="submit" data-action="pair" className={button} disabled={pairing}>
                Pair
              </button>
            </div>
          </form>
          {machines.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {machines.map((machine) => (
                <li key={machine.id} className="flex items-center justify-between gap-3 rounded-lg border border-stroke px-3 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">{machine.label}</div>
                    <div className="mt-1 truncate text-[12px] text-content/45">
                      {machine.sshHost ?? "No SSH address for this machine."}
                    </div>
                  </div>
                  {machine.sshHost ? (
                    <button
                      type="button"
                      data-action="add-machine"
                      className={button}
                      onClick={() => addMachine(machine)}
                    >
                      Add this machine
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {handed ? (
            <p className="text-[12px] leading-relaxed text-content/45">
              The SSH form is filled in. Connect when you are ready.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
