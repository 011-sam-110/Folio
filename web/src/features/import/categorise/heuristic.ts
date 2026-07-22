// The always-available, zero-AI categoriser. It composes four signals in priority order and
// stops at the first confident hit:
//
//   1. Folder structure   (highest) - a dropped folder / vault path maps to a notebook.
//   2. Source tags         (high)    - frontmatter / #hashtags; a tag equal to a notebook name
//                                      is also a notebook hint.
//   3. TF-IDF similarity   (medium)  - nearest existing notebook by topic, from its notes.
//   4. Clustering          (low)     - the remainder grouped among themselves; small clusters
//                                      become proposed notebooks, tiny leftovers go to Unsorted.
//
// Conservative on new notebooks (locked decision #3): a NEW notebook is proposed only from a
// folder shared by several items or a cluster above a minimum size; everything else defaults
// to the single Unsorted bucket, and every proposed notebook still needs explicit approval in
// review before it is created.
//
// Pure and dependency-free so it unit-tests in isolation and could also run server-side. The
// tokeniser is deliberately identical to server/src/lib/importBatch.ts so an item's vector and
// a notebook's profile are built the same way.

import type { Categoriser, CategoriserInput, CategoriserItem, Suggestion, SuggestionNotebook } from './types';
import { UNSORTED } from './types';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one',
  'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see',
  'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use', 'that',
  'this', 'with', 'have', 'from', 'they', 'will', 'your', 'what', 'when', 'were', 'there',
  'their', 'which', 'would', 'about', 'into', 'them', 'then', 'than', 'some', 'such', 'only',
  'also', 'been', 'more', 'most', 'other', 'these', 'those', 'here', 'each', 'because',
]);

// Folder names too generic to name a notebook after.
const GENERIC_FOLDERS = new Set(['notes', 'note', 'documents', 'docs', 'files', 'misc', 'untitled', 'new-folder', 'export', 'attachments', 'images']);

const SIM_THRESHOLD = 0.12; // min cosine to attach to an existing notebook
const FOLDER_GROUP_MIN = 2; // items sharing an unmatched folder to justify a new notebook
const CLUSTER_SIM = 0.18; // min cosine to be in the same cluster
const CLUSTER_MIN = 3; // min cluster size to justify a new notebook
const MAX_TAGS = 4;

function tokenize(text: string): string[] {
  const words: string[] = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Naive singular fold so "databases" folder matches a "Database" notebook and vice-versa. */
function singular(slug: string): string {
  if (slug.endsWith('ies') && slug.length > 4) return `${slug.slice(0, -3)}y`;
  if (slug.endsWith('ses') && slug.length > 4) return slug.slice(0, -2);
  if (slug.endsWith('s') && !slug.endsWith('ss') && slug.length > 3) return slug.slice(0, -1);
  return slug;
}

function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

type Vec = Map<string, number>;

function termFreq(tokens: string[]): Vec {
  const v: Vec = new Map();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

function idfWeighted(tf: Vec, docFreq: Record<string, number>, n: number): Vec {
  const v: Vec = new Map();
  for (const [term, freq] of tf) {
    const df = docFreq[term] ?? 0;
    const idf = Math.log((n + 1) / (df + 1)) + 1;
    v.set(term, freq * idf);
  }
  return v;
}

function cosine(a: Vec, b: Vec): number {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  // iterate the smaller map
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, w] of small) {
    const w2 = large.get(term);
    if (w2 !== undefined) dot += w * w2;
  }
  let na = 0;
  for (const w of a.values()) na += w * w;
  let nb = 0;
  for (const w of b.values()) nb += w * w;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

function topTerms(tf: Vec, docFreq: Record<string, number>, n: number, k: number): string[] {
  return [...tf.entries()]
    .map(([term, freq]) => {
      const df = docFreq[term] ?? 0;
      const idf = Math.log((n + 1) / (df + 1)) + 1;
      return [term, freq * idf] as [string, number];
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([term]) => term);
}

interface Prepared {
  item: CategoriserItem;
  tf: Vec;
  vec: Vec;
  leafFolder: string; // slug of the deepest folder segment, '' if none
  sourceTags: string[];
}

/** Tags: source tags first, then a couple of the item's top terms that ALREADY exist in the
 *  user's vocabulary (reinforce their taxonomy, don't invent noise). */
function tagsFor(p: Prepared, docFreq: Record<string, number>, n: number, existingTags: Set<string>): string[] {
  const out: string[] = [];
  for (const t of p.sourceTags) {
    const s = slugify(t);
    if (s && !out.includes(s)) out.push(s);
  }
  for (const term of topTerms(p.tf, docFreq, n, 8)) {
    if (out.length >= MAX_TAGS) break;
    if (existingTags.has(term) && !out.includes(term)) out.push(term);
  }
  return out.slice(0, MAX_TAGS);
}

export function categoriseHeuristic(input: CategoriserInput): Suggestion[] {
  const { items, labelSpace } = input;
  const profiles = labelSpace.profiles ?? {};
  const docFreq = labelSpace.docFreq ?? {};
  const n = labelSpace.notebookCount ?? Object.keys(profiles).length ?? 1;
  const existingTags = new Set(labelSpace.tags ?? []);

  // Existing notebooks by slug (and singular fold), for folder/tag matching.
  const nbBySlug = new Map<string, { id: string; name: string }>();
  for (const nb of labelSpace.notebooks) {
    const s = slugify(nb.name);
    if (s) {
      nbBySlug.set(s, { id: nb.id, name: nb.name });
      nbBySlug.set(singular(s), { id: nb.id, name: nb.name });
    }
  }

  // Notebook vectors for cosine similarity (IDF-weighted).
  const nbVectors = new Map<string, { name: string; vec: Vec }>();
  for (const nb of labelSpace.notebooks) {
    const prof = profiles[nb.id];
    if (!prof) continue;
    const tf: Vec = new Map(Object.entries(prof));
    nbVectors.set(nb.id, { name: nb.name, vec: idfWeighted(tf, docFreq, n) });
  }

  const prepared: Prepared[] = items.map((item) => {
    const tokens = tokenize(`${item.title} ${item.text}`);
    const tf = termFreq(tokens);
    const segs = (item.folderPath ?? []).map(slugify).filter(Boolean);
    return {
      item,
      tf,
      vec: idfWeighted(tf, docFreq, n),
      leafFolder: segs.length ? segs[segs.length - 1] : '',
      sourceTags: item.sourceTags ?? [],
    };
  });

  const out = new Map<string, Suggestion>();
  const unassigned: Prepared[] = [];

  for (const p of prepared) {
    const tags = tagsFor(p, docFreq, n, existingTags);

    // 1) folder -> existing notebook
    let matched: { id: string; name: string; rationale: string } | null = null;
    for (const seg of (p.item.folderPath ?? []).map(slugify).filter(Boolean)) {
      const hit = nbBySlug.get(seg) ?? nbBySlug.get(singular(seg));
      if (hit) {
        matched = { id: hit.id, name: hit.name, rationale: `matched folder "${seg.replace(/-/g, ' ')}"` };
        break;
      }
    }
    if (matched) {
      out.set(p.item.id, { itemId: p.item.id, notebook: { kind: 'existing', id: matched.id }, tags, confidence: 0.9, rationale: matched.rationale });
      continue;
    }

    // 2) source tag equal to an existing notebook name -> that notebook
    let tagHit: { id: string; name: string } | null = null;
    for (const t of p.sourceTags) {
      const hit = nbBySlug.get(slugify(t)) ?? nbBySlug.get(singular(slugify(t)));
      if (hit) {
        tagHit = hit;
        break;
      }
    }
    if (tagHit) {
      out.set(p.item.id, { itemId: p.item.id, notebook: { kind: 'existing', id: tagHit.id }, tags, confidence: 0.75, rationale: `tagged "${tagHit.name}"` });
      continue;
    }

    // 3) TF-IDF similarity to an existing notebook
    let best: { id: string; name: string; score: number } | null = null;
    for (const [id, nb] of nbVectors) {
      const score = cosine(p.vec, nb.vec);
      if (!best || score > best.score) best = { id, name: nb.name, score };
    }
    if (best && best.score >= SIM_THRESHOLD) {
      const confidence = Math.min(0.7, 0.3 + best.score * 0.8);
      out.set(p.item.id, { itemId: p.item.id, notebook: { kind: 'existing', id: best.id }, tags, confidence, rationale: `similar to notes in "${best.name}"` });
      continue;
    }

    unassigned.push(p);
  }

  // 4a) a consistent unmatched folder shared by several items -> ONE proposed new notebook
  const byFolder = new Map<string, Prepared[]>();
  for (const p of unassigned) {
    if (!p.leafFolder || GENERIC_FOLDERS.has(p.leafFolder) || nbBySlug.has(p.leafFolder)) continue;
    const arr = byFolder.get(p.leafFolder) ?? [];
    arr.push(p);
    byFolder.set(p.leafFolder, arr);
  }
  const stillUnassigned: Prepared[] = [];
  const claimedByFolder = new Set<string>();
  for (const [folder, group] of byFolder) {
    if (group.length >= FOLDER_GROUP_MIN) {
      const name = titleCase(folder);
      for (const p of group) {
        const tags = tagsFor(p, docFreq, n, existingTags);
        out.set(p.item.id, { itemId: p.item.id, notebook: { kind: 'new', name }, tags, confidence: 0.8, rationale: `folder "${folder.replace(/-/g, ' ')}"` });
        claimedByFolder.add(p.item.id);
      }
    }
  }
  for (const p of unassigned) if (!claimedByFolder.has(p.item.id)) stillUnassigned.push(p);

  // 4b) cluster the remainder among themselves by TF-IDF cosine (greedy agglomeration)
  const clustered = new Set<string>();
  const remaining = [...stillUnassigned];
  while (remaining.length) {
    const seed = remaining.shift()!;
    if (clustered.has(seed.item.id)) continue;
    const cluster: Prepared[] = [seed];
    for (const other of remaining) {
      if (clustered.has(other.item.id)) continue;
      if (cosine(seed.vec, other.vec) >= CLUSTER_SIM) cluster.push(other);
    }
    if (cluster.length >= CLUSTER_MIN) {
      // Name from the cluster's top distinguishing term.
      const agg: Vec = new Map();
      for (const p of cluster) for (const [t, f] of p.tf) agg.set(t, (agg.get(t) ?? 0) + f);
      const top = topTerms(agg, docFreq, n, 1)[0];
      const name = top ? titleCase(top) : UNSORTED;
      for (const p of cluster) {
        clustered.add(p.item.id);
        const tags = tagsFor(p, docFreq, n, existingTags);
        out.set(p.item.id, { itemId: p.item.id, notebook: { kind: 'new', name }, tags, confidence: 0.35, rationale: 'grouped by keywords' });
      }
    }
  }

  // 4c) tiny leftovers -> the single Unsorted bucket
  for (const p of stillUnassigned) {
    if (clustered.has(p.item.id) || out.has(p.item.id)) continue;
    const tags = tagsFor(p, docFreq, n, existingTags);
    out.set(p.item.id, { itemId: p.item.id, notebook: { kind: 'new', name: UNSORTED }, tags, confidence: 0.1, rationale: 'no clear signal' });
  }

  // Preserve input order.
  return items.map((it) => out.get(it.id) ?? fallback(it.id));
}

function fallback(itemId: string): Suggestion {
  const nb: SuggestionNotebook = { kind: 'new', name: UNSORTED };
  return { itemId, notebook: nb, tags: [], confidence: 0.1, rationale: 'no clear signal' };
}

export const heuristicCategoriser: Categoriser = {
  id: 'heuristic',
  categorise(input: CategoriserInput): Promise<Suggestion[]> {
    return Promise.resolve(categoriseHeuristic(input));
  },
};

/** Which strategy to use. Phase 1 is heuristic-only; this is where the LLM / embedding
 *  strategies slot in later, always degrading to the heuristic on any error. */
export function pickCategoriser(): Categoriser {
  return heuristicCategoriser;
}
