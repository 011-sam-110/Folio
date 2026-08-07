// Is this browser being used without an account, and how does it get in and out of that.
//
// The flag is read synchronously (localStorage, not React state) because lib/api.ts routes
// every call on it and RequireAuth decides on it during the first render, both of which
// happen before any effect could have loaded it.
import { useEffect, useState } from 'react';
import { clearData, hasGuestWork, seedGuestWorkspace, storageAvailable, subscribeGuestData } from './guestStore';

const ACTIVE_KEY = 'unote:guest:active';

const listeners = new Set<() => void>();
let active = readFlag();

function readFlag(): boolean {
  try {
    return localStorage.getItem(ACTIVE_KEY) === '1';
  } catch {
    return false;
  }
}

function emit(): void {
  listeners.forEach((l) => l());
}

/** True when the app is running on browser-local data with no account behind it. */
export function isGuest(): boolean {
  return active;
}

/** Guest mode cannot be offered where the browser refuses to persist anything. */
export function guestModeSupported(): boolean {
  return storageAvailable();
}

/**
 * Enter guest mode, seeding a notebook and one empty note on the first visit so the
 * caller has somewhere to send the person. Returns the note to open.
 */
export function startGuest(): { noteId: string | null } {
  try {
    localStorage.setItem(ACTIVE_KEY, '1');
  } catch {
    return { noteId: null };
  }
  active = true;
  let noteId: string | null = null;
  if (!hasGuestWork()) {
    try {
      noteId = seedGuestWorkspace().note.id;
    } catch {
      // Storage filled between the probe and the write. The shell still opens; the
      // dashboard's empty state is a survivable landing.
      noteId = null;
    }
  }
  emit();
  return { noteId };
}

/**
 * Leave guest mode. `keepWork` is the difference between signing in (the notes have
 * either been copied across or deliberately abandoned) and simply closing the trial.
 */
export function endGuest(options: { keepWork: boolean }): void {
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Nothing persisted, nothing to remove.
  }
  active = false;
  if (!options.keepWork) clearData();
  emit();
}

/** Live guest flag for components. */
export function useGuest(): boolean {
  const [value, setValue] = useState(active);
  useEffect(() => {
    const l = () => setValue(active);
    listeners.add(l);
    l();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return value;
}

/** Live count of what would be lost, for the banner and the migration prompt. */
export function useGuestWorkPresent(): boolean {
  const [present, setPresent] = useState(hasGuestWork);
  useEffect(() => subscribeGuestData(() => setPresent(hasGuestWork())), []);
  return present;
}
