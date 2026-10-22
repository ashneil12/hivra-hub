// Where the top-right notices stack (update notice, approval and question toasts, the new-layout prompt, reminders).
// They start below the window's 40px top bar, never on it (22 Oct): on macOS that strip is the title bar, where the
// first click on a window that isn't key only makes it key, so the update notice's X took two clicks right after a
// restart; and a notice there covered the Mono's Overview and settings buttons.

/** The top bar's height (h-10) plus the 8px gap the notices keep between them. */
export const TOAST_STACK_TOP = 48;

/** The top of a notice placed under the ones above it: each shown one adds its height and an 8px gap. */
export function toastStackTop(above: readonly number[]): number {
  return above.reduce((top, height) => (height ? top + height + 8 : top), TOAST_STACK_TOP);
}
