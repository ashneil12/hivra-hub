// WP-134b. More agents, on the providers page, off until the person switches it on.

import { useSyncExternalStore } from "react";
import {
  MORE_AGENTS_ENABLED_DEFAULT,
  loadMoreAgentsEnabled,
  saveMoreAgentsEnabled,
  subscribeMoreAgentsEnabled,
} from "../../settings/model/settings";

export function MoreAgentsSettings() {
  const on = useSyncExternalStore(
    subscribeMoreAgentsEnabled,
    loadMoreAgentsEnabled,
    () => MORE_AGENTS_ENABLED_DEFAULT,
  );

  return (
    <section id="setting-more-agents" data-setting-id="more-agents" className="pt-8">
      <h2 className="text-[13px] font-semibold text-content">More agents</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-content/45">
        A local command that speaks ACP, listed under the eleven CLIs. Off until you switch it on. It is not one of those CLIs.
      </p>
      <div className="mt-2.5 flex items-center justify-between gap-6 rounded-xl border border-content/10 bg-content/3 px-4 py-3.5">
        <span className="text-[13px] text-content">More agents</span>
        <button
          type="button"
          role="switch"
          aria-label="More agents"
          aria-checked={on}
          onClick={() => saveMoreAgentsEnabled(!on)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            on ? "bg-accent" : "bg-content/20"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${
              on ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
    </section>
  );
}
