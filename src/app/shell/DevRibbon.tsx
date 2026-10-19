import {
  appIdentity,
  stampLabel,
  type AppIdentity,
} from "../model/appIdentity";

/**
 * A corner ribbon on every window of a dev copy, so it can never be mistaken for the daily app. It takes no clicks:
 * whatever sits under it still works. The daily app shows nothing.
 */
export function DevRibbon({
  identity = appIdentity(),
}: {
  identity?: AppIdentity | null;
}) {
  if (!identity || identity.kind !== "dev") return null;
  const label = `Dev copy ${identity.slot ?? ""}: ${stampLabel(identity.stamp)}`;
  return (
    <div
      role="status"
      aria-label={label}
      title={label}
      data-dev-ribbon
      className="pointer-events-none fixed top-0 right-0 z-[2147483000] size-[92px] overflow-hidden"
    >
      <div className="absolute top-[18px] right-[-30px] w-[130px] rotate-45 bg-amber-500/90 py-[3px] text-center font-mono text-[10px] font-bold tracking-[0.2em] text-black shadow-md">
        DEV
      </div>
    </div>
  );
}
