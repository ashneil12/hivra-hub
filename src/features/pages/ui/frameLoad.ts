// WP-153: WebKit fires `load` twice for one srcdoc document. The second event is the
// same window, still this page. A new window means the frame left its page.

/** What one `load` event means for a frame we have already seen. */
export function noteFrameLoad(
  seen: object | null,
  current: object | null,
): { seen: object | null; left: boolean } {
  if (!current || current === seen) return { seen, left: false };
  return { seen: current, left: seen !== null };
}
