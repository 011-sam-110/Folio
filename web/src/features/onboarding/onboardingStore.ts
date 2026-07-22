// Onboarding state: tutorial progress, the seeded example notebook, and the set of
// one-shot hints the user has dismissed.
//
// ---------------------------------------------------------------------------
// WHY localStorage RATHER THAN THE SERVER
// ---------------------------------------------------------------------------
// There is no user-preferences surface in Unote today: `users` has no prefs column
// and `publicUser()` returns exactly { id, email, displayName }. Persisting this
// server-side would mean a schema change, a new authenticated route, and a widening
// of the auth payload — real risk against code that was hardened in a security pass
// — to store something whose worst-case failure is "a student sees a tutorial offer
// one extra time on a new device".
//
// It is also the more *correct* behaviour for what this actually stores. The tour
// anchors to real elements, and those differ by form factor: the desktop tour points
// at the sidebar, the phone tour points at the menu button that reveals it. Someone
// who ran the tour on a laptop and then opens Unote on an iPad genuinely has not
// been shown the interface they are now looking at. Per-device state matches the
// thing being remembered.
//
// The trade-off is stated rather than hidden: clearing site data replays the offer,
// and progress does not follow you between devices. Both are recoverable in one
// click, and the tutorial is re-runnable from the account menu regardless.
//
// State is keyed by user id so two accounts sharing a browser do not inherit each
// other's progress, and so signing out does not wipe what you had learned.
import { useEffect, useState } from 'react';

const PREFIX = 'folio:onboarding:v1:';

export type TourStatus =
  /** Never offered, or offered and not yet answered — the welcome card is due. */
  | 'unseen'
  /** Left mid-tour (Escape, reload, navigation away). Resumable from `step`. */
  | 'paused'
  /** Explicitly skipped. Never auto-opens again; still re-runnable on demand. */
  | 'skipped'
  /** Walked to the end. */
  | 'done';

export interface OnboardingState {
  status: TourStatus;
  /** Index into the teaching-step array the user last reached. */
  step: number;
  /** Ids created by the optional example seed, so the tour can navigate to them
   *  and so we never seed twice. */
  seeded: { notebookId: string; noteId: string; linkedNoteId: string; canvasId: string } | null;
  /** Dismissed hint ids. An object rather than an array so a stale build that
   *  no longer ships a hint id leaves the record harmlessly in place. */
  hints: Record<string, true>;
}

const EMPTY: OnboardingState = { status: 'unseen', step: 0, seeded: null, hints: {} };

let userId: string | null = null;
let state: OnboardingState = EMPTY;
const listeners = new Set<() => void>();

function keyFor(uid: string): string {
  return PREFIX + uid;
}

function read(uid: string): OnboardingState {
  try {
    const raw = localStorage.getItem(keyFor(uid));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    // Defensive: this is user-writable storage that also survives across deploys,
    // so every field is validated rather than trusted. A malformed blob degrades to
    // "new user" instead of throwing inside a render.
    return {
      status:
        parsed.status === 'paused' || parsed.status === 'skipped' || parsed.status === 'done'
          ? parsed.status
          : 'unseen',
      step: Number.isInteger(parsed.step) && parsed.step! >= 0 ? parsed.step! : 0,
      seeded:
        parsed.seeded && typeof parsed.seeded.notebookId === 'string' && typeof parsed.seeded.noteId === 'string'
          ? {
              notebookId: parsed.seeded.notebookId,
              noteId: parsed.seeded.noteId,
              // Both added after the first release of this store, so a record
              // written by an older build simply has no id here and the steps that
              // need one fall back rather than navigating to /note/undefined.
              linkedNoteId: typeof parsed.seeded.linkedNoteId === 'string' ? parsed.seeded.linkedNoteId : '',
              canvasId: typeof parsed.seeded.canvasId === 'string' ? parsed.seeded.canvasId : '',
            }
          : null,
      hints: parsed.hints && typeof parsed.hints === 'object' ? (parsed.hints as Record<string, true>) : {},
    };
  } catch {
    // Unparseable JSON, or localStorage unavailable (Safari private mode throws on
    // access, not just on write). Behave like a fresh install.
    return EMPTY;
  }
}

function write() {
  if (!userId) return;
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(state));
  } catch {
    // Storage full or blocked. The session keeps working from the in-memory copy;
    // only persistence across reloads is lost, which is not worth surfacing.
  }
}

function notify() {
  listeners.forEach((l) => l());
}

/**
 * Points the store at a signed-in user and loads their record. Called by
 * OnboardingProvider before it renders anything that reads state.
 *
 * Re-binding the same id is a no-op so a parent re-render cannot clobber
 * in-memory state with a stale disk read mid-tour.
 */
export function bindUser(uid: string | null): void {
  if (uid === userId) return;
  userId = uid;
  state = uid ? read(uid) : EMPTY;
  notify();
}

export function getOnboarding(): OnboardingState {
  return state;
}

function patch(next: Partial<OnboardingState>) {
  state = { ...state, ...next };
  write();
  notify();
}

export function setTourStatus(status: TourStatus, step = state.step): void {
  patch({ status, step });
}

export function setTourStep(step: number): void {
  patch({ step });
}

export function setSeeded(seeded: OnboardingState['seeded']): void {
  patch({ seeded });
}

/** Marks a hint permanently dismissed. There is no un-dismiss: a hint the user
 *  has closed must never reappear on its own. */
export function dismissHint(id: string): void {
  if (state.hints[id]) return;
  patch({ hints: { ...state.hints, [id]: true } });
}

export function isHintDismissed(id: string): boolean {
  return Boolean(state.hints[id]);
}

/** Re-running the tutorial clears progress but deliberately keeps `seeded` and
 *  `hints`: the example notebook must not be created twice, and re-watching the
 *  tour is not a request to have every tooltip come back. */
export function restartTour(): void {
  patch({ status: 'unseen', step: 0 });
}

/** Reactive view of the whole record. */
export function useOnboarding(): OnboardingState {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    const listener = () => setSnapshot(state);
    listeners.add(listener);
    listener(); // catch anything that changed between render and effect
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return snapshot;
}
