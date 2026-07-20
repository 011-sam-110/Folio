// Local SM-2 *mirror* — the server (routes/study.ts) is the source of truth
// for actual scheduling; the queue response doesn't expose ease/interval, so
// this only estimates a plausible current interval from `reps` to render
// "next review" hints on the rating buttons. Approximations are fine here —
// see docs/FRONTEND.md Study spec ('<10m', '1d', '3d', '7d'…).

export type Rating = 'again' | 'hard' | 'good' | 'easy';

// Rough growth ladder for a "good" streak, days-until-due by reps count.
const GOOD_DAYS_BY_REPS = [1, 3, 7, 15, 30, 60, 120, 240];

function goodDaysForReps(reps: number): number {
  const idx = Math.max(0, Math.min(reps, GOOD_DAYS_BY_REPS.length - 1));
  return GOOD_DAYS_BY_REPS[idx];
}

function formatDays(days: number): string {
  if (days < 1) {
    const minutes = Math.round(days * 24 * 60);
    if (minutes < 60) return `${Math.max(1, minutes)}m`;
    return `${Math.round(days * 24)}h`;
  }
  if (days < 30) return `${Math.round(days)}d`;
  return `${Math.round(days / 30)}mo`;
}

export function nextIntervalHints(reps: number): Record<Rating, string> {
  const good = goodDaysForReps(Math.max(0, reps));
  return {
    again: '<10m',
    hard: formatDays(Math.max(good * 0.35, 0.5)),
    good: formatDays(good),
    easy: formatDays(good * 1.9),
  };
}

/** Formats a FUTURE ISO timestamp as "in Xm/Xh/Xd/Xmo" (or 'now' if already due).
 *  `lib/format.ts`'s `relativeTime` only handles the past (it clamps negative deltas
 *  to 0 → always "just now"), so due-status chips and "next due" hints need this
 *  forward-looking counterpart instead. */
export function formatDueIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return 'soon';
  if (ms <= 0) return 'now';
  const minutes = ms / 60_000;
  if (minutes < 60) return `in ${Math.max(1, Math.round(minutes))}m`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `in ${Math.round(hours)}h`;
  const days = ms / 86_400_000;
  if (days < 30) return `in ${Math.round(days)}d`;
  return `in ${Math.round(days / 30)}mo`;
}
