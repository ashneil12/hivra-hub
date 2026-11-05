// WP-70: the tasks of this project, under the crew. WP-71 draws the board, list and timeline here too.

import { TasksScreen } from "./TasksScreen";

export function TaskPane({ project }: { project: string }) {
  return <TasksScreen cwd={project} />;
}
