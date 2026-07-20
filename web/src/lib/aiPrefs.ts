// One switch to remove every AI affordance from the app — for students who want Folio as
// a plain notebook. Persisted in localStorage; all AI UI (AI menu, selection AI, Assistant,
// Ask AI, flashcard generation) reads it through useAiEnabled(). Server endpoints still
// exist; this is a client-side visibility choice the user owns.
import { useEffect, useState } from 'react';

const KEY = 'folio:aiEnabled';
const listeners = new Set<() => void>();

export function isAiEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setAiEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // localStorage unavailable — the in-memory listeners still update this session.
  }
  listeners.forEach((l) => l());
}

/** Reactive hook — every subscribed component re-renders when the switch flips. */
export function useAiEnabled(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(isAiEnabled());
  useEffect(() => {
    const l = () => setOn(isAiEnabled());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return [on, setAiEnabled];
}
