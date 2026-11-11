import { useState, type ReactNode } from "react";
import { FirstMateInboxPanel, type FirstMateFold } from "../../crew/ui/FirstMateInboxPanel";
import { InboxNeeds } from "./InboxNeeds";

/**
 * G10: the top of the hub's Inbox is one list. The first mate's decisions are rows of the Needs you list (answered
 * through the first-mate panel's versioned answer); under it sit plugin installs, then what only the panel shows: its
 * results, failures and digest line.
 */
export function InboxOneList({
  cwd,
  onOpenSession,
  children,
}: {
  cwd?: string;
  onOpenSession?: (sessionId: string) => void;
  children?: ReactNode;
}) {
  const [firstMate, setFirstMate] = useState<FirstMateFold | null>(null);
  return (
    <>
      <InboxNeeds firstMate={firstMate} />
      {children}
      <FirstMateInboxPanel cwd={cwd} onOpenSession={onOpenSession} onFold={setFirstMate} />
    </>
  );
}
