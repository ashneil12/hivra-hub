// What had focus when the palette opened. The palette's own input takes focus
// the moment it shows, so each command is judged by where focus was before,
// with the guard its own shortcut uses.
export type PaletteFocus = { terminalFocus: boolean; pickerFocus: boolean };

const PICKERS =
  "[data-branch-picker], [data-skill-picker], [data-mention-picker], [data-access-picker], [data-model-control]";

export function paletteFocusOf(element: Element | null): PaletteFocus {
  if (!element || !element.isConnected) {
    return { terminalFocus: false, pickerFocus: false };
  }
  return {
    terminalFocus: Boolean(element.closest(".monocode-terminal")),
    pickerFocus: Boolean(element.closest(PICKERS)),
  };
}

/** The element to remember when the palette opens; the palette's own input is never it. */
export function focusBeforePalette(active: Element | null): Element | null {
  return active && !active.closest("[data-file-picker]") ? active : null;
}
