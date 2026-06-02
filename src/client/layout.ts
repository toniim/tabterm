import type { Group, Session } from "../shared/types.ts";

// Normalized sidebar arrangement for a single primary tab.
//   top    = flat order of `groupId | ungroupedSessionId`
//   groups = each groupId -> ordered child session ids
export interface Tree {
  top: string[];
  groups: Record<string, string[]>;
}

export function buildTree(
  order: string[],
  groups: Record<string, Group>,
  sessions: Record<string, Session>,
): Tree {
  const isGroup = (id: string) => id in groups;
  const top = order.filter((id) => isGroup(id) || id in sessions);
  const childMap: Record<string, string[]> = {};
  for (const gid of Object.keys(groups)) {
    childMap[gid] = Object.values(sessions)
      .filter((s) => s.groupId === gid)
      .sort((a, b) => a.position - b.position)
      .map((s) => s.id);
  }
  return { top, groups: childMap };
}

function without(tree: Tree, id: string): Tree {
  return {
    top: tree.top.filter((x) => x !== id),
    groups: Object.fromEntries(
      Object.entries(tree.groups).map(([g, ids]) => [g, ids.filter((x) => x !== id)]),
    ),
  };
}

function insertBefore(list: string[], id: string, beforeId: string | null): string[] {
  const out = list.filter((x) => x !== id);
  const idx = beforeId ? out.indexOf(beforeId) : -1;
  if (idx === -1) out.push(id);
  else out.splice(idx, 0, id);
  return out;
}

// Move `id` to top level, before `beforeId` (or to the end if null).
export function toTop(tree: Tree, id: string, beforeId: string | null): Tree {
  const t = without(tree, id);
  return { ...t, top: insertBefore(t.top, id, beforeId) };
}

// Move session `sid` into group `gid`, before `beforeSid` (or append if null).
export function intoGroup(
  tree: Tree,
  sid: string,
  gid: string,
  beforeSid: string | null,
): Tree {
  const t = without(tree, sid);
  return {
    ...t,
    groups: { ...t.groups, [gid]: insertBefore(t.groups[gid] ?? [], sid, beforeSid) },
  };
}
