// Whether the AI a given user would actually use is reachable, shared across every AI
// affordance.
//
// The user's on/off switch (aiPrefs) says whether they WANT AI. This says whether it
// would work. Both matter: without the health signal, a deployment with no reachable
// gateway still renders every AI button, and each one fails only after the user
// clicks it and waits. Dead controls that look live are worse than absent ones.
//
// Two things this file learned the hard way, from a live bug where a user who had saved a
// working personal API key was still shown no AI at all:
//
//   1. The answer is PER USER. /api/meta/ai-health now probes the caller's own key when
//      they have one, so `bad` here means "bad for you", not "bad for the operator".
//   2. `bad` must be SAYABLE. The probe result is cached for the life of the page, so a
//      verdict formed before the user fixed their settings used to persist until reload,
//      and every AI control simply stayed missing with nothing on screen explaining it.
//      refreshAiHealth() is now called whenever the credential changes, and
//      aiUnavailableMessage() gives every surface the same sentence to show.
import { useEffect, useState } from 'react';
import { api } from './api';
import type { AiHealthInfo } from './types';
import { useAiEnabled } from './aiPrefs';

export type AiStatus = 'pending' | 'ok' | 'bad';

export interface AiHealth extends AiHealthInfo {
  status: AiStatus;
}

// One probe serves the whole app. Several AI components mount at once, and each
// running its own health check would mean redundant round trips on every render.
let cached: AiHealth = { status: 'pending', ok: false };
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function probe(): Promise<void> {
  inFlight ??= api
    .aiHealth()
    .then((r) => {
      cached = { ...r, status: r.ok ? 'ok' : 'bad' };
    })
    .catch((e: unknown) => {
      cached = {
        status: 'bad',
        ok: false,
        reason: 'unreachable',
        error: e instanceof Error ? e.message : 'unreachable',
        hint: 'Unote could not ask the server about AI. Check your connection and try again.',
      };
    })
    .finally(() => {
      inFlight = null;
      emit();
    });
  return inFlight;
}

/** Force a re-probe - used by the sidebar's manual retry and after a key is saved. */
export function refreshAiHealth(): Promise<void> {
  cached = { status: 'pending', ok: false };
  emit();
  return probe();
}

/**
 * Adopt a verdict the server has already computed.
 *
 * Saving an API key returns a live probe of that exact credential, so re-asking would both
 * waste a call and race the one just made. Without this the app kept the stale `bad` it
 * formed at page load, which is precisely how "I entered my key and nothing turned on"
 * happened even once the server side was right.
 */
export function setAiHealth(health: AiHealthInfo): void {
  cached = { ...health, status: health.ok ? 'ok' : 'bad' };
  emit();
}

export function useAiHealth(): AiHealth {
  const [health, setHealth] = useState(cached);
  useEffect(() => {
    const l = () => setHealth(cached);
    listeners.add(l);
    if (cached.status === 'pending' && !inFlight) void probe();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return health;
}

/**
 * Should AI affordances be rendered at all?
 *
 * Deliberately optimistic while the probe is in flight: hiding AI on first paint
 * and popping it back a moment later is a worse flicker than the reverse, and the
 * healthy case is the common one. Once the probe says `bad`, the affordances go -
 * and the sidebar shows a visible "AI unavailable" control saying why, so the
 * disappearance is explained rather than mysterious.
 */
export function useAiAvailable(): boolean {
  const [enabled] = useAiEnabled();
  const health = useAiHealth();
  return enabled && health.status !== 'bad';
}

/**
 * One sentence for why AI is not available, in a form worth showing a student.
 *
 * The server sends a `hint` written for whoever can fix it (the user for their own key,
 * the operator for the shared gateway). The raw `error` is a transport message and is only
 * ever supporting detail - leading with "fetch failed" tells nobody anything.
 */
export function aiUnavailableMessage(health: AiHealth): { title: string; detail: string } | null {
  if (health.status !== 'bad') return null;

  const title =
    health.reason === 'not_configured'
      ? health.source === 'own-key'
        ? 'Your AI key needs an endpoint'
        : 'AI is not set up on this site'
      : health.source === 'own-key'
        ? 'Your AI key is not working'
        : 'AI is not reachable right now';

  const detail = [health.hint, health.error].filter(Boolean).join(' ');
  return { title, detail: detail || 'No further detail was reported.' };
}
