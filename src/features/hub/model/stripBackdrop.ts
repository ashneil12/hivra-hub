// The Strip colour preset's window backdrop: a fixed blue-to-rose fade
// behind the whole window, under Monocode's translucent panels. The
// Monocode preset turns it off. Stored on its own because Monocode's
// sliders have no gradient setting.
import "../ui/stripBackdrop.css";

const KEY = "monocode:hub-strip-backdrop";

export function loadStripBackdrop(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setStripBackdrop(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* best effort */
  }
  document.documentElement.classList.toggle("hub-strip-backdrop", on);
}

if (typeof document !== "undefined")
  document.documentElement.classList.toggle("hub-strip-backdrop", loadStripBackdrop());
