// How Home is arranged. Nothing is pinned until the person pins it. A saved value is untrusted.

// "projects" (Ash, 5 Nov: "a general overview of all your projects that you can customize") sits under Needs you.
export const BUILTINS = ["needs-you", "projects", "moving-now", "recent"] as const;
export type BuiltinId = (typeof BUILTINS)[number];

export type SectionRef =
  | { kind: "builtin"; id: BuiltinId }
  | { kind: "panel"; plugin: string; panelId: string };

export type HomeArrangement = {
  order: SectionRef[];
  hidden: string[];
  savedAt: number;
};

const BAD = /[\\/\0]|\.\./;

export function sectionKey(ref: SectionRef): string {
  return ref.kind === "builtin" ? ref.id : `panel:${ref.plugin}:${ref.panelId}`;
}

export function defaultArrangement(savedAt = 0): HomeArrangement {
  return {
    order: BUILTINS.map((id) => ({ kind: "builtin", id })),
    hidden: [],
    savedAt,
  };
}

function isBuiltin(id: string): id is BuiltinId {
  return (BUILTINS as readonly string[]).includes(id);
}

function parseRef(item: unknown): SectionRef | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  if (rec.kind === "builtin" && typeof rec.id === "string" && isBuiltin(rec.id)) {
    return { kind: "builtin", id: rec.id };
  }
  if (rec.kind === "panel" && typeof rec.plugin === "string" && typeof rec.panelId === "string") {
    const plugin = rec.plugin.trim();
    const panelId = rec.panelId.trim();
    if (!plugin || !panelId || BAD.test(plugin) || BAD.test(panelId)) return null;
    return { kind: "panel", plugin, panelId };
  }
  return null;
}

/** Drop a bad, empty, duplicate or path-like section. A missing built-in goes back (see below), so a partial file cannot lose Needs you. */
export function parseArrangement(raw: unknown): HomeArrangement {
  const blank = defaultArrangement(0);
  if (!raw || typeof raw !== "object") return blank;
  const rec = raw as Record<string, unknown>;
  const order: SectionRef[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rec.order)) {
    for (const item of rec.order) {
      const ref = parseRef(item);
      if (!ref) continue;
      const key = sectionKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(ref);
    }
  }
  // A missing built-in goes back, never lost: right after the built-in that comes before it in BUILTINS when that one is
  // here (so Projects, new in 0.16.14, lands under Needs you in an arrangement saved before it), else at the end.
  BUILTINS.forEach((id, index) => {
    if (seen.has(id)) return;
    const before = index > 0 ? BUILTINS[index - 1] : undefined;
    const at = before ? order.findIndex((ref) => ref.kind === "builtin" && ref.id === before) : -1;
    if (at >= 0) order.splice(at + 1, 0, { kind: "builtin", id });
    else order.push({ kind: "builtin", id });
    seen.add(id);
  });
  const hidden: string[] = [];
  const hiddenSeen = new Set<string>();
  if (Array.isArray(rec.hidden)) {
    for (const item of rec.hidden) {
      if (typeof item !== "string") continue;
      const key = item.trim();
      if (!key || BAD.test(key) || hiddenSeen.has(key) || !seen.has(key)) continue;
      hiddenSeen.add(key);
      hidden.push(key);
    }
  }
  const savedAt = typeof rec.savedAt === "number" && Number.isFinite(rec.savedAt) ? rec.savedAt : 0;
  return { order, hidden, savedAt };
}

/** Swap with the next visible neighbour. Hidden sections stay where they are. The ends do nothing. */
export function moveSection(arr: HomeArrangement, key: string, dir: -1 | 1): HomeArrangement {
  const visible = arr.order.filter((ref) => !arr.hidden.includes(sectionKey(ref)));
  const index = visible.findIndex((ref) => sectionKey(ref) === key);
  if (index < 0) return arr;
  const next = index + dir;
  if (next < 0 || next >= visible.length) return arr;
  const from = arr.order.indexOf(visible[index]);
  const to = arr.order.indexOf(visible[next]);
  if (from < 0 || to < 0) return arr;
  const order = arr.order.slice();
  const swapped = order[to];
  order[to] = order[from];
  order[from] = swapped;
  return { ...arr, order };
}

export function hideSection(arr: HomeArrangement, key: string): HomeArrangement {
  if (!arr.order.some((ref) => sectionKey(ref) === key)) return arr;
  if (arr.hidden.includes(key)) return arr;
  return { ...arr, hidden: [...arr.hidden, key] };
}

export function showSection(arr: HomeArrangement, key: string): HomeArrangement {
  if (!arr.hidden.includes(key)) return arr;
  return { ...arr, hidden: arr.hidden.filter((item) => item !== key) };
}

export function pinPanel(arr: HomeArrangement, plugin: string, panelId: string): HomeArrangement {
  const ref = parseRef({ kind: "panel", plugin, panelId });
  if (!ref) return arr;
  const key = sectionKey(ref);
  if (arr.order.some((item) => sectionKey(item) === key)) return arr;
  return { ...arr, order: [...arr.order, ref] };
}

export function unpin(arr: HomeArrangement, key: string): HomeArrangement {
  if (!key.startsWith("panel:")) return arr;
  if (!arr.order.some((ref) => sectionKey(ref) === key)) return arr;
  return {
    ...arr,
    order: arr.order.filter((ref) => sectionKey(ref) !== key),
    hidden: arr.hidden.filter((item) => item !== key),
  };
}
