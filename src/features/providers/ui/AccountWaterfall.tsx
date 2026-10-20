// Settings > Accounts: the order Ash's accounts are used in, and the switch that moves a chat on when one runs out
// (E5, model/accountWaterfall.ts).
import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "../../../shared/ui/icons";
import {
  accountAvailability,
  limitMarks,
  moveAccount,
  setWaterfallEnabled,
  waterfallEnabled,
  type UsageFor,
} from "../model/accountWaterfall";
import type { ProviderAccount, ProviderAccountProvider } from "../model/providerAccounts";

const PROVIDER_NAMES: Record<ProviderAccountProvider, string> = { claude: "Claude", codex: "Codex", devin: "Devin" };

/** "Use the next account when one runs out" for a provider with more than one account. */
export function AccountWaterfallSwitch({ provider, count }: { provider: ProviderAccountProvider; count: number }) {
  const [on, setOn] = useState(() => waterfallEnabled(provider));
  useEffect(() => setOn(waterfallEnabled(provider)), [provider, count]);
  if (count < 2) return null;
  return (
    <div className="flex items-center gap-3 border-t border-content/5 px-4 py-2.5" data-account-waterfall={provider}>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-content/85">Use the next account when one runs out</div>
        <div className="mt-0.5 text-[10px] leading-4 text-content/40">
          In this order. When an account hits its 5-hour or weekly limit, its chats and new chats move to the next one, and the chat
          says so. It comes back by itself once its window resets.
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-label={`Use the next ${PROVIDER_NAMES[provider]} account when one runs out`}
        aria-checked={on}
        onClick={() => {
          setWaterfallEnabled(provider, !on);
          setOn(!on);
        }}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-content/20"}`}
      >
        <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`} />
      </button>
    </div>
  );
}

/** The account's place in the order ("1"), Up and Down, and "Out until 3:16 AM" while it sits out. */
export function AccountOrderControls({
  account,
  index,
  count,
  usageFor,
  now,
  disabled = false,
}: {
  account: ProviderAccount;
  index: number;
  count: number;
  usageFor: UsageFor;
  now: number;
  disabled?: boolean;
}) {
  if (count < 2) return null;
  const out = accountAvailability(account, { now, usageFor, marks: limitMarks() });
  const until = out.until ? new Date(out.until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : null;
  return (
    <div className="flex shrink-0 items-center gap-1" data-account-order={account.id}>
      {!out.available && out.why !== "not-signed-in" ? (
        <span className="mr-1 text-[10px] text-content/45" data-account-out>
          {until ? `Out until ${until}` : "Out for now"}
        </span>
      ) : null}
      <span className="w-4 text-right text-[11px] tabular-nums text-content/40" aria-label={`Used ${ordinal(index + 1)}`}>
        {index + 1}
      </span>
      <button
        type="button"
        disabled={disabled || index === 0}
        aria-label={`Use ${account.label} earlier`}
        onClick={() => moveAccount(account.provider, account.id, -1)}
        className="grid size-6 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content disabled:opacity-25"
      >
        <ChevronUp className="size-3.5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        disabled={disabled || index === count - 1}
        aria-label={`Use ${account.label} later`}
        onClick={() => moveAccount(account.provider, account.id, 1)}
        className="grid size-6 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content disabled:opacity-25"
      >
        <ChevronDown className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}

function ordinal(n: number): string {
  return n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `${n}th`;
}
