// Whether the Hub's own defaults apply. No imports on purpose: hubNav.ts reads it, and hubBundle.ts pulls in the
// sessions model, which would put a cycle under every module that reads the hub selection.

/**
 * The Hub's defaults: the app opens on the hub, the sidebar's Inbox opens the project's Today, New session goes to an
 * untouched New session tab instead of adding another, and no "Try the Focused layout" invitation. They apply in the Hub bundle (VITE_MONOCODE_HUB=1), on the
 * hub's dev page (hub-dev.html sets the flag in browserTauriMock.ts) and wherever the project Leads are made
 * (hubBundle.ts makesProjectLeads). Upstream MonoCode's own build, which its browser specs load, keeps upstream's:
 * its workspace first, Inbox as an app view, a new tab for each New session, and the invitation.
 */
export function hubDefaultsOn(): boolean {
  if (import.meta.env.VITE_MONOCODE_HUB === "1") return true;
  if (typeof window === "undefined") return false;
  if ((window as { __MONOCODE_HUB_DEV_PAGE__?: boolean }).__MONOCODE_HUB_DEV_PAGE__ === true) return true;
  try {
    return localStorage.getItem("monocode:hub-leads-dev") === "1";
  } catch {
    return false;
  }
}
