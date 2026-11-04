// Turn off follows plugins_disable: one call with no project clears the global switch, and one call per project
// folder clears that folder. A list that can't be read is not a reason to turn anything off.

export type DisableArgs = { name: string; project?: string };

/** The calls that turn this plugin off everywhere it is on. `undefined` means the list couldn't be read. */
export function disableScopes(name: string, registry: unknown): DisableArgs[] | undefined {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return undefined;
  const plugins = (registry as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(plugins, name)) return [];
  const entry = (plugins as Record<string, unknown>)[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const enabled = (entry as { enabled?: unknown }).enabled;
  if (!enabled || typeof enabled !== "object" || Array.isArray(enabled)) return undefined;
  const global = (enabled as { global?: unknown }).global;
  const projects = (enabled as { projects?: unknown }).projects;
  if (typeof global !== "boolean" || !Array.isArray(projects)) return undefined;
  const calls: DisableArgs[] = [];
  if (global) calls.push({ name });
  const seen = new Set<string>();
  for (const project of projects) {
    if (typeof project !== "string") return undefined;
    if (project === "" || seen.has(project)) continue;
    seen.add(project);
    calls.push({ name, project });
  }
  return calls;
}

/** `false` when nothing was changed because the list couldn't be read. One scope failing doesn't stop the rest. */
export async function turnOffPlugin(
  name: string,
  io: { list: () => Promise<unknown>; disable: (args: DisableArgs) => Promise<unknown> },
): Promise<boolean> {
  let registry: unknown;
  try {
    registry = await io.list();
  } catch {
    return false;
  }
  const scopes = disableScopes(name, registry);
  if (!scopes) return false;
  for (const args of scopes) {
    try {
      await io.disable(args);
    } catch {
      // A timeout on one folder is not a final failure. The other scopes still turn off.
    }
  }
  return true;
}
