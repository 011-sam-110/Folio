// Module bus for the two onboarding surfaces that need to be openable from places
// that have no path to the provider's state — the command palette registers its
// commands at import time (lib/commands.ts) and the account menu lives in the
// sidebar. Same pattern as components/importModalBus.ts.
type Surface = 'tour' | 'shortcuts';

type Listener = (surface: Surface) => void;

const listeners = new Set<Listener>();

/** Opens the guided tutorial from the beginning. */
export function startTour(): void {
  listeners.forEach((l) => l('tour'));
}

/** Opens the keyboard shortcut cheatsheet. */
export function openShortcuts(): void {
  listeners.forEach((l) => l('shortcuts'));
}

/** Provider-side subscription. Returns an unsubscribe function. */
export function _subscribeOnboarding(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
