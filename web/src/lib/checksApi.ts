/**
 * The client side of the AI review check catalogue.
 *
 * The catalogue itself is deliberately NOT here. `server/src/lib/checks.ts` owns the 56
 * checks, their families, their severities and the presets, and this module does nothing
 * but fetch them from `GET /api/ai/checks`. A second copy in the web bundle would drift the
 * moment a check is added or reworded server-side, and the picker would then be offering
 * checks the prompts do not actually run - which is exactly the failure the endpoint exists
 * to make impossible. The only thing duplicated below is the *shape* of the response, which
 * TypeScript needs and which the two workspaces cannot share today because they do not
 * share a types package.
 *
 * What this module does own is the user's per-notebook selection. That is a client
 * preference, not user data: a chemistry notebook and an essay notebook want different
 * families, and neither choice is worth a database row or a migration to move between
 * devices. It lives in localStorage keyed by notebook id.
 */

import { ApiError } from './api';

export type Severity = 'critical' | 'normal' | 'minor';

export interface Check {
  /** `<familyId>.<slug>`, e.g. `accuracy.contradicts-note`. */
  id: string;
  label: string;
}

export interface Family {
  id: string;
  label: string;
  severity: Severity;
  checks: Check[];
}

export interface Preset {
  id: string;
  label: string;
  /** Family ids, not check ids - a preset turns whole model requests on and off. */
  families: string[];
}

export interface CheckCatalogue {
  families: Family[];
  presets: Preset[];
}

/**
 * Fetch the catalogue.
 *
 * This does not go through `lib/api.ts` on purpose. Every named response type in that file
 * comes from `lib/types.ts`, and the catalogue types above have to live somewhere the
 * picker and (later) the note page can both import without pulling the whole API surface
 * in; keeping the request beside its types makes this module self-contained.
 *
 * The one thing lost by not using `api.http` is its global 401 hook, which turns an expired
 * session into a single redirect to /login. That is acceptable here and only here: this
 * request is only ever made from inside an already-authenticated note page, where any of
 * the surrounding calls will trip the hook first. It is not a pattern to copy for a request
 * that could be the first one a page makes.
 */
export async function fetchCheckCatalogue(signal?: AbortSignal): Promise<CheckCatalogue> {
  const res = await fetch('/api/ai/checks', { signal });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (body?.error) msg = body.error;
    throw new ApiError(msg, res.status);
  }
  return (await res.json()) as CheckCatalogue;
}

const SELECTION_PREFIX = 'folio:aiChecks:';

/**
 * The families saved for this notebook, or `null` if the user has never chosen.
 *
 * `null` and `[]` are different answers and callers must keep them apart: `[]` is "I turned
 * everything off", which is a choice worth honouring on reload, while `null` is "no opinion
 * yet" and is what the default applies to.
 */
export function savedFamilies(notebookId: string): string[] | null {
  try {
    const raw = localStorage.getItem(SELECTION_PREFIX + notebookId);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Unparseable, or localStorage unavailable (private mode, storage disabled). Either
    // way the honest answer is "no saved choice" rather than a thrown error in a picker.
    return null;
  }
}

export function saveFamilies(notebookId: string, familyIds: string[]): void {
  try {
    localStorage.setItem(SELECTION_PREFIX + notebookId, JSON.stringify(familyIds));
  } catch {
    // Storage unavailable - the selection still applies for this session, which is a
    // better outcome than failing the interaction the user just performed.
  }
}

/**
 * What this notebook should run, given the catalogue the server just served.
 *
 * Saved ids are filtered against the live catalogue, so a family that has been removed
 * server-side quietly drops out instead of being sent to a route that no longer knows it.
 * With nothing saved the default is the catalogue's FIRST preset rather than every family:
 * a run costs one model request per family, so defaulting to all eight would make the most
 * expensive possible run the one a user gets by not deciding.
 */
export function resolveFamilies(notebookId: string, catalogue: CheckCatalogue): string[] {
  const known = new Set(catalogue.families.map((f) => f.id));
  const saved = savedFamilies(notebookId);
  if (saved) return saved.filter((id) => known.has(id));
  return catalogue.presets[0]?.families.filter((id) => known.has(id)) ?? [];
}
