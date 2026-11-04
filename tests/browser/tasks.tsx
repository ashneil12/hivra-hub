import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TaskDetail, type TaskDetailTask } from "../../src/features/tasks/ui/TaskDetail";
import "../../src/styles/index.css";

// WP-70. The activity a delegation left, and a comment the person adds.
function Page() {
  const [comments, setComments] = useState<TaskDetailTask["comments"][number][]>([]);
  const task: TaskDetailTask = {
    number: 4,
    title: "Fix the save",
    description: "The save drops the last line.",
    status: "In progress",
    needsYou: true,
    failed: false,
    assignee: "mate-1",
    comments,
    activity: [{ id: "a1", text: "recorded" }],
  };
  return (
    <TaskDetail
      task={task}
      onComment={(body) => setComments((current) => [...current, { id: `c-${current.length}`, body }])}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
