import { allConnectors, composioOn, hasDirectConnector, loginLivesOn, setComposio, signIn, useConnectorsVersion, type Connector } from "../model/connectors";
import { examples } from "../model/examples";

const EXAMPLE: Connector[] = examples([
  { id: "ex-github", name: "Example: GitHub", projectId: "exo-game", signedIn: true },
  { id: "ex-gmail", name: "Example: Gmail", projectId: "hivra", signedIn: true },
  { id: "ex-slack", name: "Example: Slack", projectId: "harness", signedIn: false },
  { id: "ex-pipedrive", name: "Example: Pipedrive", projectId: "hivra", signedIn: true },
]);

/** Settings → Connectors: each app, where its login lives, and the Composio switch. */
export function ConnectorsPage() {
  useConnectorsVersion();
  const on = composioOn();
  const list = [...allConnectors(), ...EXAMPLE.filter((e) => !allConnectors().some((c) => c.id === e.id))];
  return (
    <div className="flex flex-col gap-6" data-hub-connectors>
      <div className="flex flex-col gap-0.5">
        {list.length ? list.map((c) => (
          <div key={c.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-content/5" data-hub-connector={c.id}>
            <span className="min-w-0 flex-1 truncate text-[13px] text-content">{c.name}</span>
            {!on && !hasDirectConnector(c) ? (
              <span className="shrink-0 text-xs text-content/60" data-hub-connector-needs-composio>Needs Composio</span>
            ) : c.signedIn ? (
              <span className="shrink-0 text-xs text-content/60">{loginLivesOn(c)}</span>
            ) : (
              <button type="button" onClick={() => signIn(c.id)}
                className="shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12">Sign in</button>
            )}
          </div>
        )) : <p className="text-[13px] text-content/60">No connectors yet. When a Mono needs an app, it asks you to sign in here.</p>}
      </div>
      <div className="flex flex-col gap-1.5 px-3">
        <div className="flex items-center gap-3">
          <span className="flex-1 text-[13px] text-content">Use Composio for logins</span>
          <button type="button" role="switch" aria-checked={on} aria-label="Use Composio for logins" data-hub-composio
            onClick={() => setComposio(!on)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-content/60" : "bg-content/20"}`}>
            <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`} />
          </button>
        </div>
        {on ? (
          <p className="hub-fade-in text-[13px] text-content/60" data-hub-composio-note>
            Your logins for these apps will be stored on Composio's servers. Main apps like GitHub and Gmail stay on this Mac.
          </p>
        ) : null}
      </div>
    </div>
  );
}
