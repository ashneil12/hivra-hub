// Which model a learn run uses, said before it starts. The run asks the signed-in CLI the crew
// already routes to, at the cheap "plan" setting (a Haiku-class model for Claude Code). No key is read.

import { cliLabel } from "../../crew/model/clis";
import { roleModel, type Route } from "../../crew/model/resolve";

export type LearnModel = { cli: string; model: string | null; label: string };

/** The CLI and model a run would use, or null when no signed-in CLI is set up yet. */
export function learnModelFor(route: Route): LearnModel | null {
  if (!route.cli) return null;
  const { model } = roleModel("plan", route);
  const name = cliLabel(route.cli);
  return { cli: route.cli, model, label: model ? `${name} (${model})` : `${name} at low effort` };
}
