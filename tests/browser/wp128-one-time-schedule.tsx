// WP-128: the schedule form, on a made-up chat and project. Nothing here is installed.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryOneTimeStore } from "../../src/features/one-time-schedule/model/oneTimeSchedule";
import {
  MissedScheduleNotice,
  OneTimeSchedulePanel,
} from "../../src/features/one-time-schedule/ui/OneTimeSchedulePanel";
import "../../src/styles/index.css";

const KEY = "wp128-one-time-schedules";
const store = createMemoryOneTimeStore(sessionStorage.getItem(KEY) ?? undefined);
store.subscribe(() => {
  sessionStorage.setItem(KEY, store.dump());
});

const MISSED = {
  id: "missed-demo",
  text: 'A scheduled prompt was missed because Hivra was closed. "Check the build" was set for 2099-01-02 09:00.',
};

function Page() {
  const [notices, setNotices] = useState([MISSED]);
  return (
    <>
      <OneTimeSchedulePanel
        chats={[{ id: "chat-1", title: "Notes" }]}
        projects={[{ id: "/work/demo", label: "Demo" }]}
        store={store}
      />
      <MissedScheduleNotice
        notices={notices}
        onDone={(id) => setNotices((current) => current.filter((notice) => notice.id !== id))}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
