import { openGuardFinding } from "../model/openFinding";

/** A one-tap link on a card or status line that shows a guard refusal in the source-control panel, where it is allowed. */
export function OpenInSourceControlLink({ message }: { message: string }) {
  return (
    <button
      type="button"
      className="mt-0.5 block text-left text-[12px] underline"
      onClick={() => openGuardFinding(message)}
    >
      Open in source control
    </button>
  );
}
