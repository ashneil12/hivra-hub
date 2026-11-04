// Pure consent list for desktop control (WP-44). No filesystem and no node builtins, so Settings can import it.
// The gate in gate.mjs is what actually allows or refuses a command. These functions only edit a document.

/** @typedef {{ apps: string[], refused: string[], visible: boolean }} ProjectConsent */
/** @typedef {{ id: string, project: string, app: string }} PendingAsk */
/** @typedef {{ revision: number, projects: Record<string, ProjectConsent>, pending: PendingAsk[], nextId: number }} ConsentState */

const MAX_APP = 256;

/** `toLowerCase`, not `toLocaleLowerCase`: a Turkish locale would fold `I` to a different character. */
export function foldApp(name) {
  return name.trim().toLowerCase();
}

export function appProblem(name) {
  if (typeof name !== "string") return "Say which app.";
  const trimmed = name.trim();
  if (!trimmed) return "Say which app.";
  if (trimmed.includes("\0") || /[\r\n]/.test(trimmed)) return "That app name isn't usable.";
  if ([...trimmed].length > MAX_APP) return "That app name is too long.";
  return null;
}

/** Absolute on either platform. A relative path, including one that starts with `..`, is not. */
export function isAbsolutePath(project) {
  if (typeof project !== "string" || !project || project.includes("\0")) return false;
  if (project.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(project)) return true;
  if (project.startsWith("\\\\")) return true;
  return false;
}

export function projectBase(project) {
  if (typeof project !== "string" || !project) return "";
  const parts = project.split(/[/\\]/).filter((part) => part && part !== "." && part !== "..");
  return parts.length > 0 ? parts[parts.length - 1] : project;
}

export function emptyConsent() {
  return { revision: 0, projects: {}, pending: [], nextId: 1 };
}

function clone(state) {
  return {
    revision: state.revision,
    nextId: state.nextId,
    pending: state.pending.map((item) => ({ ...item })),
    projects: Object.fromEntries(
      Object.entries(state.projects ?? {}).map(([key, record]) => [
        key,
        {
          apps: [...(record.apps ?? [])],
          refused: [...(record.refused ?? [])],
          visible: record.visible === true,
        },
      ]),
    ),
  };
}

function ensure(state, project) {
  const found = state.projects[project];
  if (found) return found;
  const created = { apps: [], refused: [], visible: false };
  state.projects[project] = created;
  return created;
}

function has(names, key) {
  return names.some((name) => foldApp(name) === key);
}

function dropPending(state, project, key) {
  state.pending = state.pending.filter((item) => !(item.project === project && foldApp(item.app) === key));
}

export function allowApp(state, project, app) {
  if (!isAbsolutePath(project) || appProblem(app)) return state;
  const next = clone(state);
  const key = foldApp(app);
  const record = ensure(next, project);
  record.refused = record.refused.filter((name) => foldApp(name) !== key);
  if (!has(record.apps, key)) record.apps.push(app.trim());
  dropPending(next, project, key);
  return next;
}

export function refuseApp(state, project, app) {
  if (!isAbsolutePath(project) || appProblem(app)) return state;
  const next = clone(state);
  const key = foldApp(app);
  const record = ensure(next, project);
  record.apps = record.apps.filter((name) => foldApp(name) !== key);
  if (!has(record.refused, key)) record.refused.push(app.trim());
  dropPending(next, project, key);
  return next;
}

export function setVisible(state, project, visible) {
  if (!isAbsolutePath(project)) return state;
  const next = clone(state);
  ensure(next, project).visible = visible === true;
  return next;
}

/** Add one pending ask. The same project and app a second time changes nothing, including `nextId`. */
export function askApp(state, project, app) {
  if (!isAbsolutePath(project) || appProblem(app)) return state;
  const key = foldApp(app);
  const record = state.projects[project];
  if (record && (has(record.apps, key) || has(record.refused, key))) return state;
  if (state.pending.some((item) => item.project === project && foldApp(item.app) === key)) return state;
  const next = clone(state);
  const idn = Number.isInteger(next.nextId) && next.nextId > 0 ? next.nextId : 1;
  next.pending.push({ id: `ask-${idn}`, project, app: app.trim() });
  next.nextId = idn + 1;
  return next;
}

function stringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(label);
  return value.map((item) => {
    const problem = appProblem(item);
    if (problem) throw new Error(problem);
    return item.trim();
  });
}

/** Throw when `value` is not a consent document. Callers that show UI use `consentFrom` and get null instead. */
export function parseConsent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
  const revision = /** @type {{ revision?: unknown }} */ (value).revision;
  if (!Number.isInteger(revision) || revision < 0 || revision > Number.MAX_SAFE_INTEGER) throw new Error("revision");
  const nextId = /** @type {{ nextId?: unknown }} */ (value).nextId;
  if (!Number.isInteger(nextId) || nextId < 1 || nextId > Number.MAX_SAFE_INTEGER) throw new Error("nextId");
  const rawProjects = /** @type {{ projects?: unknown }} */ (value).projects ?? {};
  if (!rawProjects || typeof rawProjects !== "object" || Array.isArray(rawProjects)) throw new Error("projects");
  /** @type {Record<string, ProjectConsent>} */
  const projects = {};
  for (const [key, record] of Object.entries(rawProjects)) {
    if (!isAbsolutePath(key) || key.split(/[/\\]/).includes("..")) throw new Error("project");
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("project");
    const visible = /** @type {{ visible?: unknown }} */ (record).visible;
    if (visible !== undefined && typeof visible !== "boolean") throw new Error("visible");
    projects[key] = {
      apps: stringList(/** @type {{ apps?: unknown }} */ (record).apps, "apps"),
      refused: stringList(/** @type {{ refused?: unknown }} */ (record).refused, "refused"),
      visible: visible === true,
    };
  }
  const rawPending = /** @type {{ pending?: unknown }} */ (value).pending ?? [];
  if (!Array.isArray(rawPending)) throw new Error("pending");
  /** @type {PendingAsk[]} */
  const pending = rawPending.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("pending");
    const id = /** @type {{ id?: unknown }} */ (item).id;
    const project = /** @type {{ project?: unknown }} */ (item).project;
    const app = /** @type {{ app?: unknown }} */ (item).app;
    if (typeof id !== "string" || !id || id.length > 64 || id.includes("\0") || /[\r\n]/.test(id)) {
      throw new Error("id");
    }
    if (typeof project !== "string" || !isAbsolutePath(project) || project.split(/[/\\]/).includes("..")) {
      throw new Error("pending project");
    }
    const problem = appProblem(app);
    if (problem) throw new Error(problem);
    return { id, project, app: /** @type {string} */ (app).trim() };
  });
  return { revision, projects, pending, nextId };
}

/** Untrusted settings, disk and invoke results. Null means don't paint them and don't write over the file. */
export function consentFrom(value) {
  try {
    return parseConsent(value);
  } catch {
    return null;
  }
}
