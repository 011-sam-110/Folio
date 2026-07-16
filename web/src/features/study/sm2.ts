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
