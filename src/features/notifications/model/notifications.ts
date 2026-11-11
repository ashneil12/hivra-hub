import { invoke } from "@tauri-apps/api/core";
import { HARNESS_TITLE, sessionDisplayTitle, type Session } from "../../sessions/model/session";
import { loadSoundsEnabled, playCue } from "../../settings/model/sounds";
import {
  allowsProjectNotification,
  projectNotificationVerdict,
  type NotificationCategory,
  type NotificationSubject,
} from "./notificationPreferences";
import { monoReplyText } from "../../monos/model/monoReaction";
import { knownNotificationProject } from "./notificationProjects";
import {
  commitNotable,
  readNotableBuffer,
  saveNotableBuffer,
  type NotablePing,
} from "./notableEvents";

const KEY = "monocode.notifications";

/** Off until the user opts in; enabling asks the OS for permission. */
export const NOTIFICATIONS_DEFAULT = false;

export const NOTIFICATIONS_CHANGE_EVENT = "monocode:notifications-change";

/** Rust emits this with the session id when a notification is clicked. */
export const NOTIFICATION_CLICK_EVENT = "monocode:notification-click";

export type NotificationPermission =
  "prompt" | "granted" | "denied" | "unsupported";

export function loadNotificationsEnabled(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return NOTIFICATIONS_DEFAULT;
    return raw === "1" || raw === "true";
  } catch {
    return NOTIFICATIONS_DEFAULT;
  }
}

export function saveNotificationsEnabled(value: boolean) {
  try {
    localStorage.setItem(KEY, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(NOTIFICATIONS_CHANGE_EVENT, { detail: value }),
  );
}

let permission: NotificationPermission = "prompt";

/** Last permission the OS reported; refreshed by the probes below. */
export function cachedNotificationPermission(): NotificationPermission {
  return permission;
}

export async function probeNotificationPermission(): Promise<NotificationPermission> {
  try {
    permission = await invoke<NotificationPermission>(
      "notification_permission",
    );
  } catch {
    permission = "unsupported";
  }
  return permission;
}

/** Shows the OS prompt when undecided; otherwise reports the current state. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  try {
    permission = await invoke<NotificationPermission>(
      "request_notification_permission",
    );
  } catch {
    permission = "unsupported";
  }
  return permission;
}

export function openNotificationSettings(): Promise<void> {
  return invoke<void>("open_notification_settings");
}

/**
 * Tracked from Tauri's focus event rather than `document.hasFocus()`, which
 * WKWebView keeps reporting true after the window drops to the background.
 */
let windowFocused =
  typeof document !== "undefined" ? document.hasFocus() : true;

export function setWindowFocused(focused: boolean) {
  windowFocused = focused;
}

/**
 * A banner only earns its place while the user is looking elsewhere: another
 * app, or another session. The transcript already shows the change on the
 * session that is on screen.
 */
export function shouldNotify({
  enabled,
  permission,
  windowFocused,
  sessionVisible,
}: {
  enabled: boolean;
  permission: NotificationPermission;
  windowFocused: boolean;
  sessionVisible: boolean;
}): boolean {
  if (!enabled || (windowFocused && sessionVisible)) return false;
  return permission === "granted" || permission === "prompt";
}

export type InputNotificationEvent = {
  kind: "approval" | "question";
  requestId: number;
};
/** `failed` is a turn that ended in an error. It is announced as a failure, and quiet hours never hold it. */
export type NotificationEvent = "finished" | "failed" | InputNotificationEvent;

type PendingInputNotification = {
  session: Session;
  event: InputNotificationEvent;
};

/** Track each request, including a new request in an already-waiting session. */
export function pendingInputNotifications(
  sessions: Session[],
): Map<string, PendingInputNotification> {
  const pending = new Map<string, PendingInputNotification>();
  for (const session of sessions) {
    if (session.inboxAsk) continue;
    for (const block of session.blocks) {
      if (block.approval && !block.approval.decided) {
        pending.set(
          JSON.stringify([session.id, "approval", block.approval.requestId]),
          {
            session,
            event: { kind: "approval", requestId: block.approval.requestId },
          },
        );
      }
    }
    if (session.pendingQuestion) {
      pending.set(
        JSON.stringify([
          session.id,
          "question",
          session.pendingQuestion.requestId,
        ]),
        {
          session,
          event: {
            kind: "question",
            requestId: session.pendingQuestion.requestId,
          },
        },
      );
    }
  }
  return pending;
}

/** App name, then the session title, then the reply itself. */
export type NotificationText = {
  title: string;
  subtitle: string;
  body: string;
};

const BODY_MAX = 240;

export function notificationText(
  session: Session,
  event: NotificationEvent,
): NotificationText {
  const title = "MonoCode";
  const subtitle = sessionDisplayTitle(session.title, session.harness);
  const harness = HARNESS_TITLE[session.harness];
  if (event === "failed") {
    return { title, subtitle, body: clip(`${harness} stopped with an error`) };
  }
  if (event !== "finished") {
    if (event.kind === "question") {
      const question =
        session.pendingQuestion?.requestId === event.requestId
          ? session.pendingQuestion
          : undefined;
      const prompt = question?.title || question?.questions[0]?.prompt;
      return {
        title,
        subtitle,
        body: clip(prompt || `${harness} has a question for you`),
      };
    }
    const pending = session.blocks.find(
      (block) =>
        block.approval?.requestId === event.requestId &&
        !block.approval.decided,
    );
    const what = pending?.tool?.title || pending?.text;
    return {
      title,
      subtitle,
      body: clip(what ? `Approve: ${what}` : `${harness} needs your approval`),
    };
  }
  const reply = [...session.blocks]
    .reverse()
    .find((block) => block.role === "assistant" && block.text.trim());
  return {
    title,
    subtitle,
    body: clip((reply && monoReplyText(reply.text)) || `${harness} finished`),
  };
}

/** First paragraph, whitespace collapsed; macOS wraps and truncates the rest. */
function clip(text: string): string {
  const paragraph =
    text
      .split(/\n\s*\n/)
      .map((part) => part.replace(/\s+/g, " ").trim())
      .find((part) => part.length > 0) ?? "";
  return paragraph.length > BODY_MAX
    ? `${paragraph.slice(0, BODY_MAX - 1)}…`
    : paragraph;
}

/**
 * Sends the banner when policy allows. Resolves true once the OS accepted it
 * so callers can skip the in-app cue: the OS sound stands in for it. A
 * rejected dispatch resolves false so the cue still plays.
 */
export async function notifySession(
  session: Session,
  event: NotificationEvent,
  sessionVisible: boolean,
): Promise<boolean> {
  if (session.inboxAsk) return false;
  const occurredAt = Date.now();
  const project = knownNotificationProject(session.cwd);
  if (!project) return false;
  return notifyProjectSession(session, event, sessionVisible, {
    projectId: project.id,
    category: typeof event === "object" ? "agentInput" : "agentFinished",
    occurredAt,
    ...(event === "failed" ? { failure: true } : {}),
  });
}

/** `failed` is a turn that ended in an error: it reads as a failure and is not held overnight (WP-164). */
export function announceSessionFinished(
  session: Session,
  sessionVisible: boolean,
  failed = false,
): Promise<void> {
  return announceSession(session, failed ? "failed" : "finished", sessionVisible);
}

export function announceSessionInput(
  session: Session,
  event: InputNotificationEvent,
  sessionVisible: boolean,
): Promise<void> {
  return announceSession(session, event, sessionVisible);
}

/** One policy decision covers both the OS banner and its in-app sound fallback. */
async function announceSession(
  session: Session,
  event: NotificationEvent,
  sessionVisible: boolean,
): Promise<void> {
  if (session.inboxAsk) return;
  const occurredAt = Date.now();
  const project = knownNotificationProject(session.cwd);
  if (!project) return;
  const finished = typeof event !== "object";
  const subject: NotificationSubject = {
    projectId: project.id,
    category: finished ? "agentFinished" : "agentInput",
    occurredAt,
    ...(event === "failed" ? { failure: true } : {}),
  };
  const sent = await notifyProjectSession(
    session,
    event,
    sessionVisible,
    subject,
  );
  if (!sent) playCue(finished ? "turnFinished" : "inputRequested", subject);
}

async function notifyProjectSession(
  session: Session,
  event: NotificationEvent,
  sessionVisible: boolean,
  subject: NotificationSubject,
): Promise<boolean> {
  const verdict = projectNotificationVerdict(subject);
  if (verdict === "muted") return false;
  const decision = shouldNotify({
    enabled: loadNotificationsEnabled(),
    permission,
    windowFocused,
    sessionVisible,
  });
  if (!decision) return false;
  const { title, subtitle, body } = notificationText(session, event);
  if (verdict === "quiet") {
    // WP-164: quiet hours hold this banner and its sound. It is kept, and leaves as one ping when the window ends
    // (notableDelivery.ts). Only a banner that would have been shown is kept.
    commitNotable(readNotableBuffer, saveNotableBuffer, {
      id: `held:${session.id}:${subject.occurredAt ?? Date.now()}`,
      kind: "held",
      text: `${subtitle}: ${body}`,
      at: subject.occurredAt ?? Date.now(),
    });
    return false;
  }
  try {
    await invoke("show_notification", {
      sessionId: session.id,
      title,
      subtitle,
      body,
      sound: loadSoundsEnabled(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A stuck worker's banner (stuckNotifications.ts): its project's "Agent approvals and questions" rule, the same OS
 * policy as any other request, and a click opens the worker's chat. Without a banner the in-app cue plays.
 */
export async function announceStuckWorker(notice: {
  sessionId: string;
  cwd: string;
  title: string;
  subtitle: string;
  body: string;
}): Promise<void> {
  const project = knownNotificationProject(notice.cwd);
  if (!project) return;
  const subject: NotificationSubject = {
    projectId: project.id,
    category: "agentInput",
    occurredAt: Date.now(),
  };
  if (!allowsProjectNotification(subject)) return;
  const decision = shouldNotify({
    enabled: loadNotificationsEnabled(),
    permission,
    windowFocused,
    sessionVisible: false,
  });
  if (decision) {
    try {
      await invoke("show_notification", {
        sessionId: notice.sessionId,
        title: notice.title,
        subtitle: notice.subtitle,
        body: notice.body,
        sound: loadSoundsEnabled(),
      });
      return;
    } catch {
      /* the cue below */
    }
  }
  playCue("inputRequested", subject);
}

/**
 * A failure about work in these project folders (a red CI on a watched pull request). Quiet hours never hold it, but
 * a mute of `category` on any of those projects still silences it. A folder that is no known project has no mute.
 */
export function failureNoticeAllowed(
  folders: ReadonlyArray<string | null | undefined>,
  category: NotificationCategory,
  occurredAt: number,
): boolean {
  for (const folder of folders) {
    const project = folder ? knownNotificationProject(folder) : undefined;
    if (!project) continue;
    const verdict = projectNotificationVerdict({ projectId: project.id, category, occurredAt, failure: true });
    if (verdict === "muted") return false;
  }
  return true;
}

/** `shown`: the system took it. `off`: notifications are off or denied, so none is owed. `failed`: try again later. */
export type PingResult = "shown" | "off" | "failed";

/** Click target of a batched ping. It names no chat, so a click only brings the app forward. */
const NOTABLE_PING_ID = "programme-notices";

/**
 * Whether a batched programme ping would be shown: banners on and not denied. It belongs to no chat, so the window
 * being focused does not excuse it.
 */
export function notablePingsOn(): boolean {
  return shouldNotify({
    enabled: loadNotificationsEnabled(),
    permission,
    windowFocused,
    sessionVisible: false,
  });
}

/** One batched programme ping (notableEvents.ts), under the same OS policy as any banner. */
export async function announceNotablePing(ping: NotablePing): Promise<PingResult> {
  if (!notablePingsOn()) return "off";
  try {
    await invoke("show_notification", {
      sessionId: NOTABLE_PING_ID,
      title: "MonoCode",
      subtitle: ping.title,
      body: ping.body,
      sound: loadSoundsEnabled(),
    });
    return "shown";
  } catch {
    return "failed";
  }
}
