// Pure helpers shared by the review screen: where an item is headed, how items group under
// proposed categories, and the effective tags/target after any user edit. No React here.
import type { ImportItem } from '../../../lib/types';

export interface TargetRef {
  kind: 'existing' | 'new';
  id?: string;
  name: string;
}

/** The notebook an item will land in: an explicit decision wins, else the suggestion, else
 *  the safe Unsorted bucket. */
export function itemTarget(it: ImportItem, notebooksById: Map<string, { name: string; emoji: string }>): TargetRef {
  const id = it.decidedNotebookId ?? it.suggestedNotebookId;
  if (id) {
    const nb = notebooksById.get(id);
    return { kind: 'existing', id, name: nb?.name ?? 'Notebook' };
  }
  const name = it.decidedNotebookName ?? it.suggestedNotebookName ?? 'Unsorted';
  return { kind: 'new', name };
}

export function groupKey(t: TargetRef): string {
  return t.kind === 'existing' ? `id:${t.id}` : `new:${t.name.toLowerCase()}`;
}

export function effectiveTags(it: ImportItem): string[] {
  return it.decidedTags ?? it.suggestedTags;
}

export interface ReviewGroup {
  key: string;
  target: TargetRef;
  items: ImportItem[];
}

/** Build the left-rail groups, existing notebooks first then proposed-new, each internally
 *  ordered so the least-confident items surface first when sorting by confidence. */
export function buildGroups(items: ImportItem[], notebooksById: Map<string, { name: string; emoji: string }>): ReviewGroup[] {
  const map = new Map<string, ReviewGroup>();
  for (const it of items) {
    const target = itemTarget(it, notebooksById);
    const key = groupKey(target);
    let g = map.get(key);
    if (!g) {
      g = { key, target, items: [] };
      map.set(key, g);
    }
    g.items.push(it);
  }
  const groups = [...map.values()];
  groups.sort((a, b) => {
    // existing before new; Unsorted always last; then by name
    if (a.target.kind !== b.target.kind) return a.target.kind === 'existing' ? -1 : 1;
    const au = a.target.name.toLowerCase() === 'unsorted' ? 1 : 0;
    const bu = b.target.name.toLowerCase() === 'unsorted' ? 1 : 0;
    if (au !== bu) return au - bu;
    return a.target.name.localeCompare(b.target.name);
  });
  return groups;
}
