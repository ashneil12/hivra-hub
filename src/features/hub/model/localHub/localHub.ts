// The Hub's own record of projects, which Monos work on which project, kept Pages and the project strip (WP-04).
// These used to live in Ash OS (the retired bridge); they now live in the app's own database (src-tauri/src/local_hub.rs)
// as three documents. The answers keep the shapes Ash OS gave, so the store's readers (hubStore.ts mapProject, the
// Pages store) read them unchanged. Pages here are the record WP-33 takes over when Pages become panel plugins.
//
// Every write is saved before the call answers, so a project, a Mono's project or a kept Page survives a restart.
//
// More than one window can hold a LocalHub on the same database (open_new_window). So every change runs one at a time
// in its window, starts from the documents as they are on disk now (not this window's copy), and writes only if no
// other window wrote that document since it was read (each document has a revision); if one did, it reads again and
// makes its change on top. Every window hears each write (`watch`) and reads the record again.

/** A document as kept, with its revision (0: nothing kept yet). */
export type LocalDoc = { value: unknown; rev: number };

/** Where the documents are kept: the app's database in the app, memory in tests and the browser preview. */
export interface LocalHubDisk {
  /** The document alone (the import's marker), or null. */
  read(key: string): Promise<unknown>;
  readDoc(key: string): Promise<LocalDoc>;
  /** Keep it; with `rev`, only if it is still at that revision. The new revision, or null when it wasn't (nothing written). */
  write(key: string, value: unknown, rev?: number): Promise<number | null>;
  /** Every write to the database, from any window: its key and new revision. */
  watch?(onChange: (key: string, rev: number) => void): () => void;
}

/** How many times a change is made again on top of another window's before it gives up. */
const MAX_TRIES = 5;

export const ICON_SHAPES = ["gamepad", "sparkles", "palette", "gauge", "folder", "code", "rocket", "chart", "briefcase", "megaphone", "book", "heart", "globe", "bolt"] as const;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 .,&'()+-]{0,59}$/;
const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export type LocalProject = {
  id: string;
  name: string;
  shortName: string;
  iconShape: string;
  folder: string | null;
  /** Shared with the team (WP-80): set only by Ash's "Share with my team" click, never by a rename. */
  shared?: boolean;
  oneLine?: string;
  archived?: boolean;
  status?: string;
  createdAt?: string;
};

export type LocalMembership = { monoId: string; projectId: string; role: "lead" | "member"; addedAt: string };

export type LocalPage = {
  id: string;
  projectId: string;
  title: string;
  request: string;
  by: string;
  monoId: string;
  spec: Record<string, unknown>;
  permissions: string[];
  state: "kept" | "removed" | "preview" | "used" | "dropped";
  version: number;
  createdAt: number;
  keptAt?: number;
  pinned?: boolean;
  pinnedBy?: string;
  pinAsked?: boolean;
  /** A new version waiting on a kept page: the kept page's id. */
  replaces?: string;
};

export type LocalHubState = { projects: LocalProject[]; memberships: LocalMembership[]; pages: LocalPage[] };

export const KEYS = { projects: "projects", memberships: "memberships", pages: "pages" } as const;

type Payload = Record<string, unknown>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const words = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
export const slug = (name: string) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
const listOf = <T>(raw: unknown, key: string): T[] => {
  const list = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
  return Array.isArray(list) ? (list as T[]) : [];
};

/** A page spec's asks (a bespoke page's permissions); a blocks page asks for nothing. */
const asksOf = (spec: Record<string, unknown>): string[] =>
  spec.kind === "bespoke" && Array.isArray(spec.permissions) ? (spec.permissions as unknown[]).filter((x): x is string => typeof x === "string") : [];

function approved(perms: unknown, spec: Record<string, unknown>): string[] {
  if (!Array.isArray(perms) || !perms.every((x) => typeof x === "string")) throw new Error("permissions: a list of what the hub asked for.");
  const extra = perms.filter((x) => !asksOf(spec).includes(x));
  if (extra.length) throw new Error(`The hub didn't ask for ${extra.join(", ")}, so it can't be allowed that.`);
  return [...new Set(perms as string[])];
}

function validSpec(spec: unknown): Record<string, unknown> {
  const s = spec as Record<string, unknown> | null;
  if (!s || typeof s !== "object" || !["blocks", "bespoke"].includes(String(s.kind))) throw new Error("The hub is neither blocks nor a bespoke hub.");
  if (typeof s.title !== "string" || !s.title.trim()) throw new Error("The hub has no title.");
  if (s.kind === "blocks" && (!Array.isArray(s.blocks) || !s.blocks.length || s.blocks.length > 12)) throw new Error("The hub needs 1 to 12 blocks.");
  const { pin: _pin, pageId: _id, ...clean } = s;
  return clone(clean);
}

const DOCS = ["projects", "memberships", "pages"] as const;
type DocName = (typeof DOCS)[number];

export class LocalHub {
  private state: LocalHubState = { projects: [], memberships: [], pages: [] };
  private revs: Record<DocName, number> = { projects: 0, memberships: 0, pages: 0 };
  private loaded: Promise<void> | undefined;
  private listeners = new Set<() => void>();
  /** This window's changes, one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The revisions this window's own writes are making (`key:rev`): their change event is not news here. */
  private own = new Set<string>();

  constructor(
    readonly disk: LocalHubDisk,
    private readonly now: () => number = () => Date.now(),
  ) {
    // Another window wrote: read the record again before the next answer, and tell the store.
    disk.watch?.((key, rev) => {
      const doc = DOCS.find((d) => KEYS[d] === key);
      if (!doc || this.own.delete(`${key}:${rev}`) || rev <= this.revs[doc]) return;
      this.loaded = undefined;
      this.notify();
    });
  }

  /** The three documents as they are on disk now (a missing one is empty). */
  private async readAll(): Promise<void> {
    const docs = await Promise.all(DOCS.map((d) => this.disk.readDoc(KEYS[d])));
    DOCS.forEach((d, i) => {
      this.revs[d] = docs[i].rev;
    });
    this.state = {
      projects: listOf<LocalProject>(docs[0].value, "projects"),
      memberships: listOf<LocalMembership>(docs[1].value, "memberships"),
      pages: listOf<LocalPage>(docs[2].value, "pages"),
    };
  }

  /** Read the three documents once, and again after another window wrote. A failed read is tried again next time. */
  load(): Promise<void> {
    if (!this.loaded) {
      const reading = this.readAll();
      this.loaded = reading;
      reading.catch(() => {
        if (this.loaded === reading) this.loaded = undefined;
      });
    }
    return this.loaded;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * One change: after this window's earlier ones, on the documents as they are now. Writes only the documents it
   * changed, each only if no other window wrote it since; if one did, it reads again and makes the change on top. A
   * change that throws leaves everything as it was.
   */
  private mutate<T>(change: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
        await this.readAll();
        this.loaded = Promise.resolve();
        const before = DOCS.map((d) => JSON.stringify(this.state[d]));
        let result: T;
        try {
          result = change();
        } catch (error) {
          DOCS.forEach((d, i) => {
            (this.state as Record<DocName, unknown>)[d] = JSON.parse(before[i]);
          });
          throw error;
        }
        let wrote = false;
        let stale = false;
        for (const [i, d] of DOCS.entries()) {
          if (JSON.stringify(this.state[d]) === before[i]) continue;
          const mine = `${KEYS[d]}:${this.revs[d] + 1}`;
          if (this.disk.watch) this.own.add(mine);
          const rev = await this.disk.write(KEYS[d], { [d]: this.state[d] }, this.revs[d]).catch((error: unknown) => {
            this.own.delete(mine);
            throw error;
          });
          if (rev === null) {
            this.own.delete(mine);
            stale = true;
            break;
          }
          this.revs[d] = rev;
          wrote = true;
        }
        if (wrote) this.notify();
        if (!stale) return result;
      }
      this.loaded = undefined;
      throw new Error("The app's record kept changing in another window; try again.");
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Called after every change (the store reads the changed slices again). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A copy of everything kept (tests, the import). */
  async snapshot(): Promise<LocalHubState> {
    await this.load();
    return clone(this.state);
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  // ---- projects -------------------------------------------------------------------------------------------------------

  private visible(): LocalProject[] {
    return this.state.projects.filter((p) => !p.archived);
  }

  private known(word: unknown): LocalProject {
    const w = words(word);
    const p = this.state.projects.find((x) => x.id === String(word ?? "").trim() || words(x.name) === w);
    if (!p) throw new Error(`unknown project '${String(word ?? "")}'`);
    return p;
  }

  private nameClash(name: string, ownId?: string): void {
    const other = this.state.projects.find((p) => p.id !== ownId && (words(p.name) === words(name) || p.id === slug(name)));
    if (other) throw new Error(`"${name}" already means ${other.name} (${other.id}); pick another name`);
  }

  async projects(v: Payload = {}): Promise<{ projects: LocalProject[] }> {
    await this.load();
    return { projects: clone(this.state.projects.filter((p) => v.include_archived || !p.archived)) };
  }

  /** A new project. `folder` is where its code is (made by the caller, or one Ash already has); null for none. */
  projectCreate(v: Payload): Promise<{ project: LocalProject; folder: string | null }> {
    return this.mutate(() => {
      const name = String(v.name ?? "").trim();
      if (!PROJECT_NAME.test(name)) throw new Error("project name: up to 60 letters, digits, spaces and . , & ' ( ) + -");
      const id = String(v.project_id || slug(name));
      if (!PROJECT_ID.test(id)) throw new Error("project id: lowercase letters, digits and dashes.");
      if (this.state.projects.some((p) => p.id === id)) throw new Error(`project ${id} already exists`);
      this.nameClash(name);
      if (v.icon_shape != null && !ICON_SHAPES.includes(v.icon_shape as never)) throw new Error(`icon shape: one of ${ICON_SHAPES.join(", ")}`);
      const used = new Set(this.visible().map((p) => p.iconShape));
      const folder = typeof v.folder === "string" && v.folder.trim() ? v.folder.trim() : null;
      const oneLine = String(v.one_line ?? "").trim();
      const project: LocalProject = {
        id,
        name,
        shortName: String(v.short_name || "").trim() || name.split(/ & | \/ | - /)[0].slice(0, 12),
        iconShape: String(v.icon_shape || ICON_SHAPES.find((s) => !used.has(s)) || "folder"),
        folder,
        ...(oneLine ? { oneLine } : {}),
        status: "active",
        createdAt: this.iso(),
      };
      this.state.projects.push(project);
      return { project: clone(project), folder };
    });
  }

  projectRename(v: Payload): Promise<LocalProject> {
    return this.mutate(() => {
      const p = this.known(v.project_id);
      if (p.archived) throw new Error(`${p.id} is not on the app strip, so the app has no name or shape for it`);
      const before = JSON.stringify(p);
      if (v.name != null) {
        const name = String(v.name).trim();
        if (!PROJECT_NAME.test(name)) throw new Error("project name: up to 60 letters, digits, spaces and . , & ' ( ) + -");
        this.nameClash(name, p.id);
        p.name = name;
      }
      if (v.short_name != null) {
        const short = String(v.short_name).trim();
        if (!short || short.length > 16) throw new Error("short name: 1 to 16 characters");
        p.shortName = short;
      }
      if (v.icon_shape != null) {
        if (!ICON_SHAPES.includes(v.icon_shape as never)) throw new Error(`icon shape: one of ${ICON_SHAPES.join(", ")}`);
        p.iconShape = String(v.icon_shape);
      }
      if (v.folder !== undefined) p.folder = typeof v.folder === "string" && v.folder.trim() ? v.folder.trim() : null;
      if (v.shared != null) p.shared = Boolean(v.shared);
      if (JSON.stringify(p) === before) throw new Error("nothing to change");
      return clone(p);
    });
  }

  /**
   * Take a project off the hub (`archived`) or bring it back. Without `confirm`, archiving only says what it would
   * leave (nothing waits on Ash here any more, so the counts are 0) and changes nothing.
   */
  projectArchive(v: Payload): Promise<Record<string, unknown>> {
    return this.mutate(() => {
      const p = this.known(v.project_id);
      const archiving = v.archived !== false;
      if (archiving && v.confirm !== true) {
        if (p.archived) throw new Error(`${p.id} is already archived`);
        return { id: p.id, name: p.name, needsConfirm: true, archived: false, openAsks: 0, openNeeds: 0, say_to_ash: `Remove ${p.name} from the app? Nothing is deleted and you can bring it back.` };
      }
      if (!!p.archived === archiving) throw new Error(`${p.id} is ${archiving ? "already archived" : "not archived"}`);
      p.archived = archiving;
      return { id: p.id, archived: archiving, openAsks: 0, openNeeds: 0 };
    });
  }

  // ---- which Monos work on which project ------------------------------------------------------------------------------

  monoProjectAdd(v: Payload): Promise<{ monoId: string; projectId: string; role: "lead" | "member" }> {
    return this.mutate(() => {
      const p = this.known(v.project_id);
      const mono = String(v.mono_id ?? "").trim();
      if (!mono) throw new Error("mono_id: the Mono to add.");
      const role = v.role === "lead" ? "lead" : "member";
      const had = this.state.memberships.find((m) => m.monoId === mono && m.projectId === p.id);
      if (!had) {
        this.state.memberships.push({ monoId: mono, projectId: p.id, role, addedAt: this.iso() });
        } else if (had.role !== role && role === "lead") {
        had.role = "lead";
        }
      return { monoId: mono, projectId: p.id, role: had && had.role === "lead" ? "lead" : role };
    });
  }

  monoProjectRemove(v: Payload): Promise<{ monoId: string; projectId: string; removed: boolean }> {
    return this.mutate(() => {
      const mono = String(v.mono_id ?? "").trim();
      const projectId = String(v.project_id ?? "").trim();
      const before = this.state.memberships.length;
      this.state.memberships = this.state.memberships.filter((m) => !(m.monoId === mono && m.projectId === projectId));
      const removed = this.state.memberships.length !== before;
      return { monoId: mono, projectId, removed };
    });
  }

  async monoProjects(v: Payload = {}): Promise<{ memberships: LocalMembership[]; byProject: Record<string, string[]>; byMono: Record<string, string[]> }> {
    await this.load();
    const list = this.state.memberships.filter((m) => (!v.project || m.projectId === v.project) && (!v.mono_id || m.monoId === v.mono_id));
    const byProject: Record<string, string[]> = {};
    const byMono: Record<string, string[]> = {};
    for (const m of list) {
      (byProject[m.projectId] ||= []).push(m.monoId);
      (byMono[m.monoId] ||= []).push(m.projectId);
    }
    return { memberships: clone(list), byProject, byMono };
  }

  // ---- the strip -------------------------------------------------------------------------------------------------------

  /** The project strip in order. The Today board's sections were Ash OS's and are retired (WP-06 removes Today). */
  async layout(): Promise<{ strip: Array<Pick<LocalProject, "id" | "name" | "shortName" | "iconShape" | "shared">> }> {
    await this.load();
    return { strip: this.visible().map((p) => ({ id: p.id, name: p.name, shortName: p.shortName, iconShape: p.iconShape, ...(p.shared ? { shared: true } : {}) })) };
  }

  // ---- Pages -----------------------------------------------------------------------------------------------------------

  private newVersionOf(p: LocalPage): LocalPage | undefined {
    if (p.state !== "kept") return undefined;
    return this.state.pages.filter((x) => x.replaces === p.id && x.state === "preview").sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  private pageOut(p: LocalPage): Record<string, unknown> {
    const removed = p.state === "removed";
    const waiting = this.newVersionOf(p);
    return {
      id: p.id, projectId: p.projectId, title: p.title, request: p.request, by: p.by, monoId: p.monoId, spec: clone(p.spec),
      permissions: removed ? [] : [...p.permissions], state: p.state, version: p.version,
      ...(p.keptAt ? { keptAt: p.keptAt } : {}), ...(removed ? { removed: true } : {}),
      ...(p.pinned ? { pinned: true, pinnedBy: p.pinnedBy || "you" } : {}), ...(p.pinAsked ? { pinAsked: true } : {}),
      ...(waiting ? { newVersion: { id: waiting.id, request: waiting.request, by: waiting.by, monoId: waiting.monoId, at: waiting.createdAt, spec: clone(waiting.spec) } } : {}),
    };
  }

  private scope(word: unknown): string {
    const w = String(word ?? "").trim();
    if (!w || w === "today") return "today";
    return this.known(w).id;
  }

  private findPage(id: unknown): LocalPage {
    const p = this.state.pages.find((x) => x.id === String(id ?? "").trim());
    if (!p) throw new Error(`There is no hub ${String(id ?? "")}.`);
    return p;
  }

  async pages(v: Payload = {}): Promise<{ pages: Array<Record<string, unknown>> }> {
    await this.load();
    const target = v.projectId ?? v.project_id ?? v.project;
    const sid = target ? this.scope(target) : null;
    const states = v.include_removed ? ["kept", "removed"] : ["kept"];
    const list = this.state.pages
      .filter((p) => states.includes(p.state) && (!sid || p.projectId === sid))
      .sort((a, b) => (b.keptAt ?? 0) - (a.keptAt ?? 0) || b.createdAt - a.createdAt);
    return { pages: list.map((p) => this.pageOut(p)) };
  }

  pageUpdate(v: Payload): Promise<Record<string, unknown>> {
    return this.mutate(() => {
      const id = String(v.pageId ?? v.page_id ?? v.id ?? "").trim();
      const exists = this.state.pages.find((p) => p.id === id);
      if (!exists && v.spec && typeof v.spec === "object") {
        // A page the app built itself, saved to the record.
        if (!PAGE_ID.test(id)) throw new Error("pageId: the hub to save (letters, digits, dots, colons, dashes).");
        const sid = this.scope(v.projectId ?? v.project_id ?? v.project);
        const spec = validSpec(v.spec);
        const kept = v.kept === true;
        const t = this.now();
        const row: LocalPage = {
          id, projectId: sid, title: String(spec.title), request: String(v.request ?? ""), by: String(v.by || v.monoId || "app"), monoId: String(v.monoId || "app"),
          spec, permissions: kept ? approved(v.permissions ?? [], spec) : [], state: kept ? "kept" : "preview", version: 1, createdAt: t,
          ...(kept ? { keptAt: t } : {}), ...(kept && v.pinned ? { pinned: true, pinnedBy: String(v.pinnedBy || "you") } : {}),
        };
        this.state.pages.push(row);
        return this.pageOut(row);
      }
      const p = this.findPage(id);
      if (p.state === "removed") throw new Error("That hub was removed. Restore it first.");
      let changed = false;
      const versionId = v.useVersion ?? v.dropVersion;
      if (versionId) {
        const ver = this.state.pages.find((x) => x.id === versionId && x.replaces === p.id && x.state === "preview");
        if (!ver) throw new Error("That new version is gone: ask for the change again.");
        if (v.useVersion) {
          p.spec = clone(ver.spec);
          p.title = String(p.spec.title);
          if (!("permissions" in v)) p.permissions = p.permissions.filter((x) => asksOf(p.spec).includes(x));
          ver.state = "used";
        } else {
          ver.state = "dropped";
        }
        changed = true;
      }
      if (v.spec != null) {
        p.spec = validSpec(v.spec);
        p.title = String(p.spec.title);
        if (p.permissions.length && !("permissions" in v)) p.permissions = [];
        changed = true;
      }
      if (v.title != null) {
        if (typeof v.title !== "string" || !v.title.trim() || v.title.length > 80) throw new Error("title: up to 80 characters.");
        p.title = v.title;
        p.spec.title = v.title;
        changed = true;
      }
      if (v.kept === true && p.state !== "kept") {
        p.state = "kept";
        p.keptAt = this.now();
        if (!("permissions" in v)) p.permissions = [...asksOf(p.spec)];
        changed = true;
      }
      if ("permissions" in v) {
        p.permissions = approved(v.permissions, p.spec);
        changed = true;
      }
      if (v.pinned != null) {
        p.pinned = !!v.pinned;
        p.pinnedBy = p.pinned ? String(v.pinnedBy || v.pinned_by || "you") : undefined;
        changed = true;
      }
      if (!changed) throw new Error("Nothing to change: say kept, permissions, pinned, title, spec, useVersion or dropVersion.");
      p.version += 1;
      return this.pageOut(p);
    });
  }

  pageRemove(v: Payload): Promise<Record<string, unknown>> {
    return this.mutate(() => {
      const p = this.findPage(v.pageId ?? v.page_id ?? v.id);
      const want = v.restore ? "kept" : "removed";
      if (p.state === want) return { ...this.pageOut(p), changed: false };
      if (v.restore && !(p.state === "removed" && p.keptAt)) throw new Error("Only a hub Ash kept and then removed can be restored.");
      p.state = want;
      if (want === "kept" && !p.permissions.length) p.permissions = [...asksOf(p.spec)];
      p.version += 1;
      return { ...this.pageOut(p), changed: true };
    });
  }

  // ---- the one-time import ----------------------------------------------------------------------------------------------

  /**
   * Add what Ash OS held (ashOsImport.ts): projects, memberships and kept Pages. Only adds: a project, membership or
   * page already here is left as it is. Returns how many of each were added.
   */
  importFrom(found: { projects: unknown[]; memberships: unknown[]; pages: unknown[] }): Promise<{ projects: number; memberships: number; pages: number }> {
    return this.mutate(() => {
      const added = { projects: 0, memberships: 0, pages: 0 };
      for (const raw of found.projects) {
        const r = (raw ?? {}) as Record<string, unknown>;
        const id = typeof r.id === "string" ? r.id.trim() : "";
        if (!id || this.state.projects.some((p) => p.id === id)) continue;
        const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : id;
        this.state.projects.push({
          id,
          name,
          shortName: typeof r.shortName === "string" && r.shortName.trim() ? r.shortName.trim() : name.slice(0, 12),
          iconShape: ICON_SHAPES.includes(r.iconShape as never) ? String(r.iconShape) : "folder",
          folder: typeof r.folder === "string" && r.folder.trim() ? r.folder : null,
          ...(r.archived === true ? { archived: true } : {}),
          ...(typeof r.status === "string" ? { status: r.status } : {}),
        });
        added.projects += 1;
      }
      const projectIds = new Set(this.state.projects.map((p) => p.id));
      for (const raw of found.memberships) {
        const r = (raw ?? {}) as Record<string, unknown>;
        const monoId = typeof r.monoId === "string" ? r.monoId : "";
        const projectId = typeof r.projectId === "string" ? r.projectId : "";
        if (!monoId || !projectIds.has(projectId) || this.state.memberships.some((m) => m.monoId === monoId && m.projectId === projectId)) continue;
        this.state.memberships.push({ monoId, projectId, role: r.role === "lead" ? "lead" : "member", addedAt: typeof r.addedAt === "string" ? r.addedAt : this.iso() });
        added.memberships += 1;
      }
      for (const raw of found.pages) {
        const r = (raw ?? {}) as Record<string, unknown>;
        const id = typeof r.id === "string" ? r.id : "";
        if (!id || r.state !== "kept" || r.removed === true || this.state.pages.some((p) => p.id === id)) continue;
        let spec: Record<string, unknown>;
        try {
          spec = validSpec(r.spec);
        } catch {
          continue;
        }
        const projectId = typeof r.projectId === "string" && (r.projectId === "today" || projectIds.has(r.projectId)) ? r.projectId : "today";
        const t = this.now();
        this.state.pages.push({
          id, projectId, title: typeof r.title === "string" ? r.title : String(spec.title), request: typeof r.request === "string" ? r.request : "",
          by: typeof r.by === "string" ? r.by : "app", monoId: typeof r.monoId === "string" ? r.monoId : "app", spec,
          permissions: Array.isArray(r.permissions) ? (r.permissions as unknown[]).filter((x): x is string => typeof x === "string" && asksOf(spec).includes(x)) : [],
          state: "kept", version: typeof r.version === "number" ? r.version : 1, createdAt: t, keptAt: typeof r.keptAt === "number" ? r.keptAt : t,
          ...(r.pinned === true ? { pinned: true, pinnedBy: typeof r.pinnedBy === "string" ? r.pinnedBy : "you" } : {}),
        });
        added.pages += 1;
      }
      return added;
    });
  }
}

/**
 * A disk in memory: tests, the browser preview, and a webview with no Tauri. Two LocalHubs on one memory disk behave
 * like two windows on one database: revisions, refused stale writes and the change event included.
 */
export function memoryDisk(seed: Record<string, unknown> = {}): LocalHubDisk & { docs: Map<string, unknown> } {
  const docs = new Map<string, unknown>(Object.entries(seed).map(([k, v]) => [k, clone(v)]));
  const revs = new Map<string, number>([...docs.keys()].map((k) => [k, 1]));
  const watchers = new Set<(key: string, rev: number) => void>();
  return {
    docs,
    async read(key) {
      return docs.has(key) ? clone(docs.get(key)) : null;
    },
    async readDoc(key) {
      return { value: docs.has(key) ? clone(docs.get(key)) : null, rev: revs.get(key) ?? 0 };
    },
    async write(key, value, rev) {
      const current = revs.get(key) ?? 0;
      if (rev !== undefined && rev !== current) return null;
      docs.set(key, clone(value));
      revs.set(key, current + 1);
      for (const watcher of [...watchers]) watcher(key, current + 1);
      return current + 1;
    },
    watch(onChange) {
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    },
  };
}
