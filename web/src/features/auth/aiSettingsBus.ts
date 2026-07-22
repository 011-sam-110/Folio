// Module bus for opening the AI settings dialog from outside the account menu that owns it.
// Same pattern as onboarding/onboardingBus.ts and components/importModalBus.ts.
//
// It exists for one reason: when AI is unavailable the sidebar now says so out loud, and
// that message is only useful if it can take the reader to the one screen that can fix it.
// Before this, AI simply vanished from the app with nothing to click and nothing to read -
// which is how a broken deployment went unnoticed long enough to be reported as "entering
// my API key does nothing".
type Listener = () => void;

const listeners = new Set<Listener>();

/** Opens the AI usage and key dialog. */
export function openAiSettings(): void {
  listeners.forEach((l) => l());
}

/** Owner-side subscription. Returns an unsubscribe function. */
export function _subscribeAiSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
