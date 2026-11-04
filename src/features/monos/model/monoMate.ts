// WP-21: a Mono's turn is the first mate contract plus its soul, and its own crew rules beat the project's.

import { mergeRules, type CrewRule } from "../../crew/model/rules";
import { resolveRoute, type Presence, type Route, type RouteTask } from "../../crew/model/resolve";
import { withFirstMateContract } from "../../firstmate/model/contract";
import { monoContext, type AgentContextPlan, type MonoFiles } from "./monoFiles";
import type { MonoLook } from "./mono";

/** The note handed to a Mono: its soul and memory, then the first mate contract. One copy of the contract. */
export function monoTurnNote(
  look: MonoLook,
  files: MonoFiles,
  plan: AgentContextPlan,
  options: Parameters<typeof monoContext>[3] = {},
): string {
  return withFirstMateContract(monoContext(look, files, plan, options));
}

/**
 * A Mono's chat is a first mate. The same object comes back, so a caller that already holds it sees the flag.
 * Setting it again changes nothing.
 */
export function stampFirstMate<T extends { firstMate?: boolean }>(session: T): T {
  if (session.firstMate !== true) session.firstMate = true;
  return session;
}

/** Person's Mono rules, then the project's, then plugin rules. First match wins. */
export function routeForMono(
  task: RouteTask,
  monoRules: readonly CrewRule[],
  projectRules: readonly CrewRule[],
  pluginRules: readonly CrewRule[],
  present: readonly Presence[],
): Route {
  return resolveRoute(task, mergeRules(monoRules, projectRules, pluginRules), present);
}
